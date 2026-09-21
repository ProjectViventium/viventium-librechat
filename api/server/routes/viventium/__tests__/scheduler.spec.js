/* === VIVENTIUM START ===
 * Feature: Scheduler gateway tests (Telegram mapping resolve)
 * Added: 2026-01-17
 * === VIVENTIUM END === */

const express = require('express');
const { EventEmitter } = require('events');

let mockGetUserById;
let mockGetMessage;
let mockGetMessages;
let mockGetConvo;
let mockResolveTelegramMappingByUserId;
let mockGetAgent;
let mockGetJob;
let mockGetActiveStreamIdForConversation;
let mockGetResumeState;
let mockSubscribe;
let mockBuildScheduledGlassHiveCapabilityBundle;
let mockRevokeScheduledGlassHiveCapabilityGrant;
let mockAbortJob;
let mockGetCortexInsightDeliveriesForParent;
let mockDeleteSchedulerPlaceholder;
let mockUpdateSchedulerConversation;
let mockGetSchedulerExternalWorkSummary;
let mockConfiguredMainAgentId = '';
let lastParentMessageId = null;
let lastSpec = null;
let lastAgentId = null;
let lastScheduledAgentExecution = null;
let lastSchedulerModel = null;
let lastSchedulerReasoningEffort = null;
let lastExternalWorkRequired = null;
let lastInteractionContext = null;
let lastSchedulerMessageId = null;
let lastSchedulerRequest = null;
let lastSchedulerTitleHandler = null;
let agentControllerCalls = 0;
const mockSchedulerDispatchIntents = new Map();

jest.mock(
  '@librechat/data-schemas',
  () => ({
    ...jest.requireActual('@librechat/data-schemas'),
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
      ...(mockConfiguredMainAgentId
        ? { interface: { defaultAgent: mockConfiguredMainAgentId } }
        : {}),
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
      endpoints: {
        agents: {
          capabilityRequiredProviders: ['glasshive-harness'],
          providerCapabilities: {
            'glasshive-harness': {
              main_chat: true,
              models: [
                {
                  id: 'codex-cli:gpt-5.6-sol',
                  effortChoices: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
                },
              ],
            },
          },
        },
      },
    };
    next();
  },
  validateConvoAccess: (_req, _res, next) => next(),
  buildEndpointOption: (_req, _res, next) => next(),
}));

jest.mock(
  '~/server/controllers/agents/request',
  () => (req, res, _next, _initialize, titleHandler) => {
    agentControllerCalls += 1;
    lastSchedulerRequest = req;
    lastSchedulerTitleHandler = titleHandler;
    lastParentMessageId = req.body.parentMessageId;
    lastSpec = req.body.spec;
    lastAgentId = req.body.agent_id;
    lastScheduledAgentExecution = req.viventiumScheduledAgentExecution ?? null;
    lastSchedulerModel = req.body.model ?? null;
    lastSchedulerReasoningEffort = req.body.reasoning_effort ?? null;
    lastExternalWorkRequired = req.viventiumSchedulerExternalWorkRequired ?? null;
    lastInteractionContext = req._viventiumInteractionContext ?? null;
    lastSchedulerMessageId = req.body.messageId ?? null;
    res.json({ streamId: req.body.streamId, conversationId: req.body.conversationId || 'new' });
  },
);

jest.mock('mongoose', () => {
  const mongoose = jest.requireActual('mongoose');
  return {
    ...mongoose,
    default: mongoose,
    connection: {
      collection: () => ({
        findOne: jest.fn(async ({ _id }) => mockSchedulerDispatchIntents.get(_id) ?? null),
        updateOne: jest.fn(async ({ _id }, update) => {
          if (!mockSchedulerDispatchIntents.has(_id)) {
            mockSchedulerDispatchIntents.set(_id, { _id, ...update.$setOnInsert });
            return { upsertedCount: 1 };
          }
          if (update.$set) {
            mockSchedulerDispatchIntents.set(_id, {
              ...mockSchedulerDispatchIntents.get(_id),
              ...update.$set,
            });
          }
          return { upsertedCount: 0 };
        }),
      }),
    },
  };
});

jest.mock('~/server/services/Endpoints/agents', () => ({
  initializeClient: jest.fn(),
}));

jest.mock('~/server/services/Endpoints/agents/title', () => jest.fn());

jest.mock('~/models', () => ({
  getUserById: (...args) => mockGetUserById(...args),
  getMessage: (...args) => mockGetMessage(...args),
  getMessages: async (filter, ...args) => {
    if (typeof filter?.messageId === 'string') {
      const message = await mockGetMessage(filter);
      return message ? [message] : [];
    }
    return mockGetMessages(filter, ...args);
  },
  getConvo: (...args) => mockGetConvo(...args),
}));

jest.mock('~/models/Agent', () => ({
  getAgent: (...args) => mockGetAgent(...args),
}));

jest.mock('~/db/models', () => ({
  Message: {
    findOneAndDelete: (...args) => mockDeleteSchedulerPlaceholder(...args),
  },
  Conversation: {
    collection: {
      updateOne: (...args) => mockUpdateSchedulerConversation(...args),
    },
  },
}));

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  GenerationJobManager: {
    getActiveStreamIdForConversation: (...args) => mockGetActiveStreamIdForConversation(...args),
    getJob: (...args) => mockGetJob(...args),
    getResumeState: (...args) => mockGetResumeState(...args),
    subscribe: (...args) => mockSubscribe(...args),
    abortJob: (...args) => mockAbortJob(...args),
  },
}));

jest.mock('~/server/services/TelegramLinkService', () => ({
  resolveTelegramMappingByUserId: (...args) => mockResolveTelegramMappingByUserId(...args),
}));

jest.mock('~/server/services/viventium/CortexInsightDeliveryService', () => ({
  getCortexInsightDeliveriesForParent: (...args) =>
    mockGetCortexInsightDeliveriesForParent(...args),
}));

jest.mock('~/server/services/viventium/interactionContext', () => ({
  ...jest.requireActual('~/server/services/viventium/interactionContext'),
  setTrustedInteractionContext: (req, context) => {
    req._viventiumInteractionContext = context;
  },
}));

jest.mock('~/server/services/viventium/noResponseTag', () => {
  const noResponseTag = '{NTA}';
  const noResponseOnly = /^\s*\{\s*NTA\s*\}\s*$/i;
  const trailingNta = /\s*\{\s*NTA\s*\}\s*$/i;
  const isNoResponseOnly = (text) => typeof text === 'string' && noResponseOnly.test(text);
  return {
    NO_RESPONSE_TAG: noResponseTag,
    isNoResponseOnly,
    isNoResponseTag: isNoResponseOnly,
    normalizeNoResponseText: (text) =>
      isNoResponseOnly(text) ? noResponseTag : typeof text === 'string' ? text : '',
    stripTrailingNTA: (text) =>
      typeof text === 'string' && !isNoResponseOnly(text)
        ? text.replace(trailingNta, '').trimEnd()
        : text,
  };
});

jest.mock('~/server/services/viventium/GlassHiveCapabilityBootstrapService', () => ({
  buildScheduledGlassHiveCapabilityBundle: (...args) =>
    mockBuildScheduledGlassHiveCapabilityBundle(...args),
  revokeScheduledGlassHiveCapabilityGrant: (...args) =>
    mockRevokeScheduledGlassHiveCapabilityGrant(...args),
}));

jest.mock('~/server/services/viventium/GlassHiveCallbackBindingService', () => ({
  getSchedulerExternalWorkSummary: (...args) => mockGetSchedulerExternalWorkSummary(...args),
}));

jest.mock('~/server/services/viventium/CortexInsightDeliveryService', () => ({
  getCortexInsightDeliveriesForParent: (...args) =>
    mockGetCortexInsightDeliveriesForParent(...args),
}));

jest.mock('~/server/services/viventium/CortexInsightDeliveryService', () => ({
  getCortexInsightDeliveriesForParent: (...args) =>
    mockGetCortexInsightDeliveriesForParent(...args),
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

describe('/api/viventium/scheduler/glasshive-capabilities', () => {
  beforeEach(() => {
    jest.resetModules();
    mockGetUserById = jest.fn().mockResolvedValue({ _id: 'user_1', role: 'USER' });
    mockGetMessage = jest.fn().mockResolvedValue(null);
    mockGetMessages = jest.fn().mockResolvedValue([]);
    mockGetConvo = jest.fn().mockResolvedValue(null);
    mockResolveTelegramMappingByUserId = jest.fn().mockResolvedValue(null);
    mockGetAgent = jest.fn().mockResolvedValue(null);
    mockGetJob = jest.fn().mockResolvedValue(null);
    mockGetResumeState = jest.fn().mockResolvedValue(null);
    mockSubscribe = jest.fn().mockResolvedValue({ unsubscribe: jest.fn() });
    mockBuildScheduledGlassHiveCapabilityBundle = jest.fn().mockResolvedValue({
      bootstrapBundle: {
        env: { GLASSHIVE_CAPABILITY_BROKER_TOKEN: 'ephemeral-token' },
      },
      grantRef: {
        grant_id: 'ghcb_sched_stable',
        execution_mode: 'host',
      },
      capabilityStatus: { status: 'ready' },
    });
    mockRevokeScheduledGlassHiveCapabilityGrant = jest
      .fn()
      .mockResolvedValue({ revoked: true, grantId: 'ghcb_sched_stable' });
    process.env.VIVENTIUM_SCHEDULER_SECRET = 'scheduler_secret';
  });

  test('mints a fire-time grant for the authenticated scheduler user', async () => {
    const app = createTestApp(require('../scheduler'));
    const req = createMockReq({
      url: '/api/viventium/scheduler/glasshive-capabilities/grant',
      headers: { 'x-viventium-scheduler-secret': 'scheduler_secret' },
      body: {
        userId: 'user_1',
        scheduleId: 'schedule-1',
        scheduledRunId: 'sp_run_1',
        executionMode: 'host',
        requiredServerNames: ['ms-365'],
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.bootstrapBundle.env.GLASSHIVE_CAPABILITY_BROKER_TOKEN).toBe('ephemeral-token');
    expect(mockBuildScheduledGlassHiveCapabilityBundle).toHaveBeenCalledWith({
      user: expect.objectContaining({ id: 'user_1' }),
      scheduleId: 'schedule-1',
      scheduledRunId: 'sp_run_1',
      executionMode: 'host',
      requiredServerNames: ['ms-365'],
    });
  });

  test('returns a structured action-required response without minting for another user', async () => {
    const error = new Error('Reconnect the required account');
    error.status = 409;
    error.code = 'connected_account_action_required';
    error.serverNames = ['ms-365'];
    mockBuildScheduledGlassHiveCapabilityBundle.mockRejectedValue(error);
    const app = createTestApp(require('../scheduler'));
    const req = createMockReq({
      url: '/api/viventium/scheduler/glasshive-capabilities/grant',
      headers: { 'x-viventium-scheduler-secret': 'scheduler_secret' },
      body: {
        userId: 'user_1',
        scheduleId: 'schedule-1',
        scheduledRunId: 'sp_run_1',
        executionMode: 'host',
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({
      error: 'Scheduled GlassHive capability authorization failed',
      reason: 'connected_account_action_required',
      failure_class: 'connected_account_action_required',
      failure_retryable: false,
      action_required: true,
      server_names: ['ms-365'],
    });
  });

  test('revokes the exact user/run/mode grant idempotently', async () => {
    const app = createTestApp(require('../scheduler'));
    const req = createMockReq({
      url: '/api/viventium/scheduler/glasshive-capabilities/revoke',
      headers: { 'x-viventium-scheduler-secret': 'scheduler_secret' },
      body: {
        userId: 'user_1',
        scheduleId: 'schedule-1',
        scheduledRunId: 'sp_run_1',
        executionMode: 'host',
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.body).toEqual({
      revoked: true,
      grant_id: 'ghcb_sched_stable',
    });
    expect(mockRevokeScheduledGlassHiveCapabilityGrant).toHaveBeenCalledWith({
      user: expect.objectContaining({ id: 'user_1' }),
      scheduleId: 'schedule-1',
      scheduledRunId: 'sp_run_1',
      executionMode: 'host',
    });
  });
});

describe('/api/viventium/scheduler/telegram/resolve', () => {
  beforeEach(() => {
    jest.resetModules();
    lastParentMessageId = null;
    lastSpec = null;
    lastAgentId = null;
    lastScheduledAgentExecution = null;
    lastSchedulerModel = null;
    lastSchedulerReasoningEffort = null;
    lastExternalWorkRequired = null;
    agentControllerCalls = 0;
    mockSchedulerDispatchIntents.clear();
    lastInteractionContext = null;
    lastSchedulerMessageId = null;
    lastSchedulerRequest = null;
    lastSchedulerTitleHandler = null;
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
    mockAbortJob = jest.fn().mockResolvedValue({ success: true });
    mockDeleteSchedulerPlaceholder = jest.fn().mockResolvedValue({ _id: 'message-object-id' });
    mockUpdateSchedulerConversation = jest.fn().mockResolvedValue({ modifiedCount: 1 });
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

  test('does not log private upstream details when Telegram mapping fails', async () => {
    const privateDetail = 'synthetic-scheduler-log-secret-never-publish';
    mockResolveTelegramMappingByUserId = jest.fn().mockRejectedValue(
      Object.assign(new Error('Upstream rejected ' + privateDetail), {
        code: 'provider_unauthorized',
        status: 401,
        response: { body: privateDetail },
      }),
    );
    const schedulerRouter = require('../scheduler');
    const { logger } = require('@librechat/data-schemas');
    const app = createTestApp(schedulerRouter);
    const req = createMockReq({
      url: '/api/viventium/scheduler/telegram/resolve',
      headers: { 'x-viventium-scheduler-secret': 'scheduler_secret' },
      body: { userId: 'user_1' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(logger.error.mock.calls)).toContain('provider_unauthorized');
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(privateDetail);
  });
});

describe('/api/viventium/scheduler/chat', () => {
  beforeEach(() => {
    jest.resetModules();
    mockConfiguredMainAgentId = '';
    agentControllerCalls = 0;
    mockGetActiveStreamIdForConversation = jest.fn().mockResolvedValue(undefined);
    mockSchedulerDispatchIntents.clear();
    lastParentMessageId = null;
    lastSpec = null;
    lastAgentId = null;
    lastScheduledAgentExecution = null;
    lastSchedulerModel = null;
    lastSchedulerReasoningEffort = null;
    lastSchedulerMessageId = null;
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
    mockGetSchedulerExternalWorkSummary = jest.fn().mockResolvedValue({
      requiredTotal: 0,
      requiredTerminal: 0,
      requiredFailed: 0,
      allRequiredTerminal: true,
      state: 'none',
      items: [],
    });
    mockSubscribe = jest.fn().mockResolvedValue({ unsubscribe: jest.fn() });
    mockAbortJob = jest.fn().mockResolvedValue({ success: true });
    mockDeleteSchedulerPlaceholder = jest.fn().mockResolvedValue({ _id: 'message-object-id' });
    mockUpdateSchedulerConversation = jest.fn().mockResolvedValue({ modifiedCount: 1 });
    process.env.VIVENTIUM_SCHEDULER_SECRET = 'scheduler_secret';
    process.env.DOMAIN_SERVER = 'http://example.com';
  });

  test('defers before reserving a dispatch or creating a response while its conversation is active', async () => {
    const conversationId = 'a1111111-1111-4111-8111-111111111111';
    mockGetConvo = jest
      .fn()
      .mockResolvedValue({ conversationId, user: 'user_1', endpoint: 'agents' });
    mockGetMessages = jest.fn().mockResolvedValue([
      {
        messageId: 'prior-user',
        parentMessageId: '00000000-0000-0000-0000-000000000000',
        createdAt: '2026-03-26T20:00:00Z',
        isCreatedByUser: true,
      },
      {
        messageId: 'prior-answer',
        parentMessageId: 'prior-user',
        createdAt: '2026-03-26T20:01:00Z',
        isCreatedByUser: false,
      },
    ]);
    mockGetActiveStreamIdForConversation.mockResolvedValue('interactive-stream');
    const app = createTestApp(require('../scheduler'));
    const body = {
      userId: 'user_1',
      text: 'Synthetic check',
      conversationId,
      agentId: 'agent_test',
      idempotencyKey: 'same-occurrence',
    };
    const first = createMockRes();
    await dispatch(
      app,
      createMockReq({
        url: '/api/viventium/scheduler/chat',
        headers: { 'x-viventium-scheduler-secret': 'scheduler_secret' },
        body,
      }),
      first,
    );
    expect(first.statusCode).toBe(202);
    expect(first.body).toEqual({
      deferred: true,
      reason: 'conversation_session_authority_conflict',
      conversationId,
    });
    expect(mockGetActiveStreamIdForConversation).toHaveBeenCalledWith('user_1', conversationId);
    expect(mockSchedulerDispatchIntents.size).toBe(0);
    expect(agentControllerCalls).toBe(0);
    mockGetActiveStreamIdForConversation.mockResolvedValue(undefined);
    const retry = createMockRes();
    await dispatch(
      app,
      createMockReq({
        url: '/api/viventium/scheduler/chat',
        headers: { 'x-viventium-scheduler-secret': 'scheduler_secret' },
        body,
      }),
      retry,
    );
    expect(retry.statusCode).toBe(200);
    expect(agentControllerCalls).toBe(1);
    const repeated = createMockRes();
    await dispatch(
      app,
      createMockReq({
        url: '/api/viventium/scheduler/chat',
        headers: { 'x-viventium-scheduler-secret': 'scheduler_secret' },
        body,
      }),
      repeated,
    );
    expect(repeated.body.duplicate).toBe(true);
    expect(agentControllerCalls).toBe(1);
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
    expect(lastExternalWorkRequired).toBe(true);
  });

  test('keeps internal scheduler execution envelopes out of the visible conversation title', async () => {
    const addTitle = require('~/server/services/Endpoints/agents/title');
    addTitle.mockClear();
    const schedulerRouter = require('../scheduler');
    const app = createTestApp(schedulerRouter);
    const req = createMockReq({
      url: '/api/viventium/scheduler/chat',
      headers: { 'x-viventium-scheduler-secret': 'scheduler_secret' },
      body: {
        userId: 'user_1',
        text: '<!--viv_internal:brew_begin--> ## Background Processing',
        titleText: 'Review the synthetic renewal reminder',
        conversationId: 'new',
        agentId: 'agent_test',
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);
    await lastSchedulerTitleHandler(lastSchedulerRequest, {
      text: req.body.text,
      response: { conversationId: 'conversation-1' },
      client: {},
    });

    expect(addTitle).toHaveBeenCalledWith(
      lastSchedulerRequest,
      expect.objectContaining({ text: 'Review the synthetic renewal reminder' }),
    );
  });

  test('carries only a validated scheduler-owned informational-work policy', async () => {
    const schedulerRouter = require('../scheduler');
    const app = createTestApp(schedulerRouter);
    const req = createMockReq({
      url: '/api/viventium/scheduler/chat',
      headers: { 'x-viventium-scheduler-secret': 'scheduler_secret' },
      body: {
        userId: 'user_1',
        text: 'synthetic scheduled prompt',
        conversationId: 'new',
        agentId: 'agent_test',
        externalWorkRequired: false,
        viventiumSchedulerExternalWorkRequired: true,
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(lastExternalWorkRequired).toBe(false);
  });

  test('preserves only authenticated structured QA provenance for downstream exclusion', async () => {
    const schedulerRouter = require('../scheduler');
    const app = createTestApp(schedulerRouter);
    const req = createMockReq({
      url: '/api/viventium/scheduler/chat',
      headers: { 'x-viventium-scheduler-secret': 'scheduler_secret' },
      body: {
        userId: 'user_1',
        text: 'synthetic QA schedule',
        conversationId: 'new',
        agentId: 'agent_test',
        viventiumQaRun: true,
        viventiumQaRunId: 'run-qa-123',
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(lastSchedulerRequest.body.viventiumQaRun).toBe(true);
    expect(lastSchedulerRequest.body.viventiumQaRunId).toBe('run-qa-123');
    expect(lastInteractionContext).toEqual(
      expect.objectContaining({
        qa_run: true,
        qa_run_id: 'run-qa-123',
      }),
    );
  });

  test('rejects malformed scheduler QA provenance before authoring', async () => {
    const schedulerRouter = require('../scheduler');
    const app = createTestApp(schedulerRouter);
    const req = createMockReq({
      url: '/api/viventium/scheduler/chat',
      headers: { 'x-viventium-scheduler-secret': 'scheduler_secret' },
      body: {
        userId: 'user_1',
        text: 'synthetic QA schedule',
        conversationId: 'new',
        agentId: 'agent_test',
        viventiumQaRun: 'true',
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual(expect.objectContaining({ reason: 'invalid_qa_provenance' }));
    expect(agentControllerCalls).toBe(0);
  });

  test('rejects a malformed scheduler external-work policy before authoring', async () => {
    const schedulerRouter = require('../scheduler');
    const app = createTestApp(schedulerRouter);
    const req = createMockReq({
      url: '/api/viventium/scheduler/chat',
      headers: { 'x-viventium-scheduler-secret': 'scheduler_secret' },
      body: {
        userId: 'user_1',
        text: 'synthetic scheduled prompt',
        conversationId: 'new',
        agentId: 'agent_test',
        externalWorkRequired: 'false',
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual(expect.objectContaining({ reason: 'invalid_external_work_policy' }));
    expect(agentControllerCalls).toBe(0);
  });

  test('authenticated scheduler request cannot override the Agent Builder route', async () => {
    const schedulerRouter = require('../scheduler');
    const app = createTestApp(schedulerRouter);
    const req = createMockReq({
      url: '/api/viventium/scheduler/chat',
      headers: { 'x-viventium-scheduler-secret': 'scheduler_secret' },
      body: {
        userId: 'user_1',
        text: 'synthetic scheduled prompt',
        conversationId: 'new',
        agentId: 'agent_test',
        scheduledAgentExecution: {
          provider: 'openai',
          model: 'gpt-5.6-sol',
          reasoning_effort: 'xhigh',
        },
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(lastScheduledAgentExecution).toBeNull();
    expect(lastSchedulerModel).toBeNull();
    expect(lastSchedulerReasoningEffort).toBeNull();
  });

  test('uses the current configured Main instead of stale conversation or request agent identities', async () => {
    mockConfiguredMainAgentId = 'agent-current-main';
    mockGetConvo = jest.fn().mockResolvedValue({
      conversationId: 'conversation-main-continuity',
      endpoint: 'agents',
      agent_id: 'agent-stale-specialist',
    });
    const schedulerRouter = require('../scheduler');
    const app = createTestApp(schedulerRouter);
    const req = createMockReq({
      url: '/api/viventium/scheduler/chat',
      headers: { 'x-viventium-scheduler-secret': 'scheduler_secret' },
      body: {
        userId: 'user_1',
        text: 'Continue the existing Main work.',
        conversationId: 'conversation-main-continuity',
        agentId: 'agent-request-specialist',
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(lastAgentId).toBe('agent-current-main');
  });

  test('removes nested fallback, GlassHive, and effort overrides before Main initialization', async () => {
    const schedulerRouter = require('../scheduler');
    const app = createTestApp(schedulerRouter);
    const req = createMockReq({
      url: '/api/viventium/scheduler/chat',
      headers: { 'x-viventium-scheduler-secret': 'scheduler_secret' },
      body: {
        userId: 'user_1',
        text: 'Continue the existing Main work.',
        conversationId: 'new',
        agentId: 'agent_test',
        effort: 'max',
        fallback: { provider: 'synthetic-unapproved', model: 'synthetic-unapproved-model' },
        fallbackProvider: 'synthetic-unapproved',
        fallbackModel: 'synthetic-unapproved-model',
        glasshive_options: { fallback_provider: 'synthetic-unapproved' },
        glasshiveOptions: { fallback_model: 'synthetic-unapproved-model' },
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(lastSchedulerRequest.body).not.toHaveProperty('effort');
    expect(lastSchedulerRequest.body).not.toHaveProperty('fallback');
    expect(lastSchedulerRequest.body).not.toHaveProperty('fallbackProvider');
    expect(lastSchedulerRequest.body).not.toHaveProperty('fallbackModel');
    expect(lastSchedulerRequest.body).not.toHaveProperty('glasshive_options');
    expect(lastSchedulerRequest.body).not.toHaveProperty('glasshiveOptions');
  });

  test('reuses one accepted stream for duplicate authenticated idempotency key', async () => {
    const schedulerRouter = require('../scheduler');
    const app = createTestApp(schedulerRouter);
    const body = {
      userId: 'user_1',
      text: 'synthetic scheduled prompt',
      conversationId: 'new',
      agentId: 'agent_test',
      idempotencyKey: 'occurrence:synthetic:2026-08-11T00:00:00Z',
    };

    const first = createMockRes();
    await dispatch(
      app,
      createMockReq({
        url: '/api/viventium/scheduler/chat',
        headers: { 'x-viventium-scheduler-secret': 'scheduler_secret' },
        body,
      }),
      first,
    );
    const duplicate = createMockRes();
    await dispatch(
      app,
      createMockReq({
        url: '/api/viventium/scheduler/chat',
        headers: { 'x-viventium-scheduler-secret': 'scheduler_secret' },
        body,
      }),
      duplicate,
    );
    const reconciled = createMockRes();
    await dispatch(
      app,
      createMockReq({
        method: 'GET',
        url: `/api/viventium/scheduler/dispatches/${encodeURIComponent(body.idempotencyKey)}?userId=user_1`,
        headers: { 'x-viventium-scheduler-secret': 'scheduler_secret' },
        query: { userId: 'user_1' },
      }),
      reconciled,
    );

    expect(first.body.streamId).toBe(duplicate.body.streamId);
    expect(duplicate.body.duplicate).toBe(true);
    expect(reconciled.body.streamId).toBe(first.body.streamId);
    expect(reconciled.body.state).toBe('accepted');
    expect(agentControllerCalls).toBe(1);
  });

  test('authors one deterministic server-owned message identity for a scheduled occurrence', async () => {
    const schedulerRouter = require('../scheduler');
    const app = createTestApp(schedulerRouter);
    const body = {
      userId: 'user_1',
      text: 'synthetic scheduled prompt',
      conversationId: 'new',
      agentId: 'agent_test',
      idempotencyKey: 'occurrence:synthetic:stable-turn',
      messageId: 'forged-caller-message',
    };

    const first = createMockRes();
    await dispatch(
      app,
      createMockReq({
        url: '/api/viventium/scheduler/chat',
        headers: { 'x-viventium-scheduler-secret': 'scheduler_secret' },
        body,
      }),
      first,
    );
    const firstMessageId = lastSchedulerMessageId;

    mockSchedulerDispatchIntents.clear();
    const replay = createMockRes();
    await dispatch(
      app,
      createMockReq({
        url: '/api/viventium/scheduler/chat',
        headers: { 'x-viventium-scheduler-secret': 'scheduler_secret' },
        body,
      }),
      replay,
    );

    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(firstMessageId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(firstMessageId).not.toBe(body.messageId);
    expect(lastSchedulerMessageId).toBe(firstMessageId);
  });

  test('returns the durable required external-work summary for a scheduled occurrence', async () => {
    mockGetSchedulerExternalWorkSummary.mockResolvedValueOnce({
      requiredTotal: 2,
      requiredTerminal: 1,
      requiredFailed: 0,
      allRequiredTerminal: false,
      state: 'waiting_external',
      items: [
        { workRef: 'work-1', required: true, state: 'running' },
        { workRef: 'work-2', required: true, state: 'completed' },
      ],
    });
    const schedulerRouter = require('../scheduler');
    const app = createTestApp(schedulerRouter);
    const idempotencyKey = 'schedule:synthetic-external-work';
    const body = {
      userId: 'user_1',
      text: 'synthetic scheduled prompt',
      conversationId: 'new',
      agentId: 'agent_test',
      scheduleId: 'schedule-1',
      idempotencyKey,
      deliveryChannels: ['telegram', 'librechat'],
    };
    const accepted = createMockRes();
    await dispatch(
      app,
      createMockReq({
        url: '/api/viventium/scheduler/chat',
        headers: { 'x-viventium-scheduler-secret': 'scheduler_secret' },
        body,
      }),
      accepted,
    );

    const reconciled = createMockRes();
    await dispatch(
      app,
      createMockReq({
        method: 'GET',
        url: `/api/viventium/scheduler/dispatches/${encodeURIComponent(idempotencyKey)}?userId=user_1`,
        headers: { 'x-viventium-scheduler-secret': 'scheduler_secret' },
        query: { userId: 'user_1' },
      }),
      reconciled,
    );

    expect(mockGetSchedulerExternalWorkSummary).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: 'user_1',
        schedulerDispatchDocumentId: expect.any(String),
      }),
    );
    expect(reconciled.body.externalWork).toEqual(
      expect.objectContaining({
        requiredTotal: 2,
        requiredTerminal: 1,
        state: 'waiting_external',
      }),
    );
  });

  test('explicitly cancels only a running scheduler-owned authoring stream', async () => {
    mockAbortJob.mockResolvedValueOnce({
      success: true,
      jobData: {
        responseMessageId: 'assistant-placeholder',
        conversationId: 'conversation-scheduled',
      },
    });
    mockGetJob.mockResolvedValueOnce({
      status: 'running',
      metadata: {
        userId: 'user_1',
        interactionContext: {
          actor_kind: 'system',
          origin: 'scheduler',
          surface: 'workbench',
        },
      },
    });
    const schedulerRouter = require('../scheduler');
    const app = createTestApp(schedulerRouter);
    const res = createMockRes();

    await dispatch(
      app,
      createMockReq({
        url: '/api/viventium/scheduler/stream/stream-timeout/cancel',
        headers: { 'x-viventium-scheduler-secret': 'scheduler_secret' },
        body: { userId: 'user_1', reason: 'stream_timeout' },
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, cancelled: 'stream-timeout' });
    expect(mockAbortJob).toHaveBeenCalledWith('stream-timeout');
    expect(mockDeleteSchedulerPlaceholder).toHaveBeenCalledWith(
      expect.objectContaining({
        user: 'user_1',
        messageId: 'assistant-placeholder',
        unfinished: true,
      }),
    );
    expect(mockUpdateSchedulerConversation).toHaveBeenCalledWith(
      { user: 'user_1', conversationId: 'conversation-scheduled' },
      expect.objectContaining({
        $pull: { messages: 'message-object-id' },
        $set: { isArchived: true },
      }),
    );
  });

  test('does not let scheduler credentials cancel an interactive stream', async () => {
    mockGetJob.mockResolvedValueOnce({
      status: 'running',
      metadata: {
        userId: 'user_1',
        interactionContext: {
          actor_kind: 'external_user',
          origin: 'interactive',
          surface: 'web',
        },
      },
    });
    const schedulerRouter = require('../scheduler');
    const app = createTestApp(schedulerRouter);
    const res = createMockRes();

    await dispatch(
      app,
      createMockReq({
        url: '/api/viventium/scheduler/stream/web-stream/cancel',
        headers: { 'x-viventium-scheduler-secret': 'scheduler_secret' },
        body: { userId: 'user_1', reason: 'stream_timeout' },
      }),
      res,
    );

    expect(res.statusCode).toBe(409);
    expect(res.body.reason).toBe('not_scheduler_authoring');
    expect(mockAbortJob).not.toHaveBeenCalled();
  });

  test("does not reveal another owner's scheduler stream existence", async () => {
    mockGetJob.mockResolvedValueOnce({
      status: 'running',
      metadata: {
        userId: 'another-owner',
        interactionContext: { actor_kind: 'system', origin: 'scheduler' },
      },
    });
    const schedulerRouter = require('../scheduler');
    const app = createTestApp(schedulerRouter);
    const res = createMockRes();

    await dispatch(
      app,
      createMockReq({
        url: '/api/viventium/scheduler/stream/foreign-stream/cancel',
        headers: { 'x-viventium-scheduler-secret': 'scheduler_secret' },
        body: { userId: 'user_1', reason: 'stream_timeout' },
      }),
      res,
    );

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Scheduler stream not found' });
    expect(mockAbortJob).not.toHaveBeenCalled();
  });

  test('authors a trusted noninteractive Workbench context and ignores forged privileged fields', async () => {
    const schedulerRouter = require('../scheduler');
    const app = createTestApp(schedulerRouter);
    const req = createMockReq({
      url: '/api/viventium/scheduler/chat',
      headers: { 'x-viventium-scheduler-secret': 'scheduler_secret' },
      body: {
        userId: 'user_1',
        text: 'synthetic scheduled prompt',
        conversationId: 'new',
        agentId: 'agent_test',
        source_event_id: 'scheduled-run-42',
        scheduleId: 'schedule-42',
        scheduleRunId: 'run-42',
        interactionContext: {
          actor: 'user',
          origin: 'user',
          surface: 'telegram',
          interactionMode: 'interactive',
        },
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(lastInteractionContext).toEqual({
      actor_kind: 'system',
      origin: 'scheduler',
      surface: 'workbench',
      conversation_id: 'new',
      revision: 1,
      source_event_id: 'scheduled-run-42',
      schedule_id: 'schedule-42',
      schedule_run_id: 'run-42',
    });
  });

  test('ignores a partial legacy scheduled-agent tuple and uses Agent Builder', async () => {
    const schedulerRouter = require('../scheduler');
    const app = createTestApp(schedulerRouter);
    const req = createMockReq({
      url: '/api/viventium/scheduler/chat',
      headers: { 'x-viventium-scheduler-secret': 'scheduler_secret' },
      body: {
        userId: 'user_1',
        text: 'synthetic scheduled prompt',
        conversationId: 'new',
        agentId: 'agent_test',
        scheduledAgentExecution: {
          provider: 'openai',
          model: 'gpt-5.6-sol',
        },
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(lastScheduledAgentExecution).toBeNull();
    expect(lastSchedulerModel).toBeNull();
  });

  test('authenticated scheduler request uses Agent Builder despite a legacy model tuple', async () => {
    const schedulerRouter = require('../scheduler');
    const app = createTestApp(schedulerRouter);
    const req = createMockReq({
      url: '/api/viventium/scheduler/chat',
      headers: { 'x-viventium-scheduler-secret': 'scheduler_secret' },
      body: {
        userId: 'user_1',
        text: 'synthetic scheduled prompt',
        conversationId: 'new',
        agentId: 'agent_test',
        scheduledAgentExecution: {
          provider: 'openai',
          model: 'gpt-5.6-sol',
          reasoning_effort: 'xhigh',
        },
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(lastScheduledAgentExecution).toBeNull();
    expect(lastSchedulerModel).toBeNull();
    expect(lastSchedulerReasoningEffort).toBeNull();
  });

  test('authenticated scheduler request ignores a legacy GlassHive tuple', async () => {
    const schedulerRouter = require('../scheduler');
    const app = createTestApp(schedulerRouter);
    const req = createMockReq({
      url: '/api/viventium/scheduler/chat',
      headers: { 'x-viventium-scheduler-secret': 'scheduler_secret' },
      body: {
        userId: 'user_1',
        text: 'synthetic scheduled harness prompt',
        conversationId: 'new',
        agentId: 'agent_test',
        scheduledAgentExecution: {
          provider: 'glasshive-harness',
          model: 'codex-cli:gpt-5.6-sol',
          reasoning_effort: 'ultra',
        },
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(lastScheduledAgentExecution).toBeNull();
    expect(lastSchedulerModel).toBeNull();
    expect(lastSchedulerReasoningEffort).toBeNull();
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
    mockGetJob = jest.fn().mockResolvedValue({
      metadata: {
        userId: 'user_1',
        interactionContext: { logical_turn_id: 'turn-stream-1', revision: 3 },
      },
    });
    mockGetResumeState = jest.fn().mockResolvedValue(null);
    mockSubscribe = jest.fn().mockImplementation(async (_streamId, onChunk, onDone) => {
      onChunk({
        event: 'on_message_delta',
        data: { delta: { content: [{ type: 'text', text: 'Hello ' }] } },
      });
      onDone({
        final: true,
        responseMessage: { text: 'Hello world', messageId: 'msg-1' },
        responseMessageId: 'msg-1',
      });
      return { unsubscribe: jest.fn() };
    });
    process.env.VIVENTIUM_SCHEDULER_SECRET = 'scheduler_secret';
  });

  test('preserves a typed retryable authority conflict in canonical FINAL', async () => {
    mockSubscribe = jest.fn().mockImplementation(async (_streamId, _onChunk, onDone) => {
      onDone({
        final: true,
        responseMessage: {
          messageId: 'response-1',
          error: false,
          content: [
            {
              type: 'error',
              error: 'Synthetic private failure detail',
              error_class: 'conversation_session_authority_conflict',
              failure_retryable: true,
              failure_contract_version: 1,
            },
          ],
        },
      });
      return { unsubscribe: jest.fn() };
    });
    const app = createTestApp(require('../scheduler'));
    const res = createMockRes();
    await dispatch(
      app,
      createMockReq({
        method: 'GET',
        url: '/api/viventium/scheduler/stream/scheduler-1',
        headers: { 'x-viventium-scheduler-secret': 'scheduler_secret' },
        query: { userId: 'user_1' },
      }),
      res,
    );
    const writes = res.write.mock.calls.map(([value]) => value).join('\n');
    expect(writes).toContain('"error_class":"conversation_session_authority_conflict"');
    expect(writes).toContain('"failure_retryable":true');
    expect(writes).not.toContain('Synthetic private failure detail');
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
    expect(writes).toContain('"logical_turn_id":"turn-stream-1"');
    expect(writes).toContain('"revision":3');
  });

  test.each(['stream', 'events'])(
    'redacts nested provider failures and credentials from resumed %s scheduler streams',
    async (endpoint) => {
      const resumedErrorSecret = 'synthetic-resumed-provider-error-never-publish';
      const resumedHeaderSecret = 'synthetic-resumed-provider-header-never-publish';
      const resumedApiKey = 'synthetic-resumed-provider-api-key-never-publish';
      const resumeState = {
        conversationId: 'conversation-resume-visible',
        responseMessageId: 'message-resume-visible',
        userMessage: { text: 'Keep the owner-visible scheduled request.' },
        aggregatedContent: [
          { type: 'text', text: 'Keep the owner-visible scheduled response.' },
          {
            type: 'error',
            error: 'Raw provider response: ' + resumedErrorSecret,
            error_class: 'provider_unauthorized',
            failure_retryable: false,
            failure_contract_version: 1,
            response: { body: resumedErrorSecret },
          },
        ],
        runSteps: [
          {
            id: 'run-step-visible',
            stepDetails: {
              progress: 'Keep the owner-visible run progress.',
              lastError: {
                code: 'provider_unauthorized',
                message: resumedErrorSecret,
                response: { data: { api_key: resumedApiKey } },
              },
              request: {
                headers: {
                  authorization: 'Bearer ' + resumedHeaderSecret,
                  'x-api-key': resumedApiKey,
                  'x-request-id': 'request-id-visible',
                },
              },
            },
          },
        ],
      };
      mockGetResumeState = jest.fn().mockResolvedValue(resumeState);
      const schedulerRouter = require('../scheduler');
      const app = createTestApp(schedulerRouter);
      const req = createMockReq({
        method: 'GET',
        url: '/api/viventium/scheduler/' + endpoint + '/scheduler-private-resume',
        headers: { 'x-viventium-scheduler-secret': 'scheduler_secret' },
        query: { userId: 'user_1', resume: 'true' },
      });
      const res = createMockRes();

      await dispatch(app, req, res);

      const writes = res.write.mock.calls.map(([value]) => value).join('\n');
      expect(writes).toContain('"conversationId":"conversation-resume-visible"');
      expect(writes).toContain('"responseMessageId":"message-resume-visible"');
      expect(writes).toContain('Keep the owner-visible scheduled request.');
      expect(writes).toContain('Keep the owner-visible scheduled response.');
      expect(writes).toContain('Keep the owner-visible run progress.');
      expect(writes).toContain('"x-request-id":"request-id-visible"');
      expect(writes).toContain('"error_class":"provider_unauthorized"');
      expect(writes).toContain('"failure_retryable":false');
      expect(writes).toContain('"failure_contract_version":1');
      expect(writes).not.toContain(resumedErrorSecret);
      expect(writes).not.toContain(resumedHeaderSecret);
      expect(writes).not.toContain(resumedApiKey);
      expect(resumeState.runSteps[0].stepDetails.request.headers.authorization).toContain(
        resumedHeaderSecret,
      );
    },
  );

  test.each([
    ['stream', 'on_cortex_update'],
    ['events', 'on_cortex_update'],
    ['stream', 'on_cortex_followup'],
    ['events', 'on_cortex_followup'],
  ])(
    'redacts nested provider failures from %s %s scheduler status events',
    async (endpoint, eventName) => {
      const providerBodySecret = 'synthetic-status-provider-body-never-publish';
      const providerHeaderSecret = 'synthetic-status-provider-header-never-publish';
      const providerAccessToken = 'synthetic-status-provider-access-token-never-publish';
      mockSubscribe = jest.fn().mockImplementation(async (_streamId, onChunk, onDone) => {
        onChunk({
          event: eventName,
          data: {
            runId: 'run-status-visible',
            cortex_name: 'Pattern Recognition',
            status: 'brewing',
            text: 'Keep the owner-visible cortex update.',
            provider: {
              name: 'xai',
              model: 'grok-4.5',
              error: {
                code: 'provider_rate_limited',
                message: 'Raw provider response: ' + providerBodySecret,
                response: {
                  body: providerBodySecret,
                  headers: { authorization: 'Bearer ' + providerHeaderSecret },
                },
              },
            },
            diagnostics: {
              progress: 2,
              credentials: { accessToken: providerAccessToken },
              request: {
                headers: {
                  Authorization: 'Bearer ' + providerHeaderSecret,
                  'x-request-id': 'status-request-visible',
                },
              },
            },
          },
        });
        onDone({
          final: true,
          responseMessage: {
            text: 'Keep the final scheduled answer.',
            messageId: 'message-status-visible',
          },
        });
        return { unsubscribe: jest.fn() };
      });
      const schedulerRouter = require('../scheduler');
      const app = createTestApp(schedulerRouter);
      const req = createMockReq({
        method: 'GET',
        url: '/api/viventium/scheduler/' + endpoint + '/scheduler-private-status',
        headers: { 'x-viventium-scheduler-secret': 'scheduler_secret' },
        query: { userId: 'user_1' },
      });
      const res = createMockRes();

      await dispatch(app, req, res);

      const writes = res.write.mock.calls.map(([value]) => value).join('\n');
      expect(writes).toContain(eventName);
      expect(writes).toContain('"runId":"run-status-visible"');
      expect(writes).toContain('"cortex_name":"Pattern Recognition"');
      expect(writes).toContain('"status":"brewing"');
      expect(writes).toContain('Keep the owner-visible cortex update.');
      expect(writes).toContain('"name":"xai"');
      expect(writes).toContain('"model":"grok-4.5"');
      expect(writes).toContain('"progress":2');
      expect(writes).toContain('"x-request-id":"status-request-visible"');
      expect(writes).toContain('"error_class":"provider_rate_limited"');
      expect(writes).toContain('Keep the final scheduled answer.');
      expect(writes).not.toContain(providerBodySecret);
      expect(writes).not.toContain(providerHeaderSecret);
      expect(writes).not.toContain(providerAccessToken);
    },
  );

  test.each(['stream', 'events'])(
    'redacts upstream provider details from the %s scheduler event stream',
    async (endpoint) => {
      const privateDetail = 'synthetic-provider-secret-never-publish';
      mockSubscribe = jest
        .fn()
        .mockImplementation(async (_streamId, _onChunk, _onDone, onError) => {
          onError(
            Object.assign(new Error('Upstream rejected ' + privateDetail), {
              code: 'provider_unauthorized',
              status: 401,
              response: { data: { token: privateDetail } },
            }),
          );
          return { unsubscribe: jest.fn() };
        });
      const schedulerRouter = require('../scheduler');
      const app = createTestApp(schedulerRouter);
      const req = createMockReq({
        method: 'GET',
        url: '/api/viventium/scheduler/' + endpoint + '/scheduler-private-1',
        headers: { 'x-viventium-scheduler-secret': 'scheduler_secret' },
        query: { userId: 'user_1' },
      });
      const res = createMockRes();

      await dispatch(app, req, res);

      const writes = res.write.mock.calls.map((call) => call[0]).join('\n');
      expect(writes).toContain('"error_class":"provider_unauthorized"');
      expect(writes).not.toContain(privateDetail);
      expect(writes).not.toContain('Upstream rejected');
    },
  );

  test.each(['stream', 'events'])(
    'preserves the flat public failure contract for %s scheduler error events',
    async (endpoint) => {
      mockSubscribe = jest
        .fn()
        .mockImplementation(async (_streamId, _onChunk, _onDone, onError) => {
          onError({ code: 'provider_unauthorized', message: 'Private upstream response' });
          return { unsubscribe: jest.fn() };
        });
      const schedulerRouter = require('../scheduler');
      const app = createTestApp(schedulerRouter);
      const req = createMockReq({
        method: 'GET',
        url: '/api/viventium/scheduler/' + endpoint + '/scheduler-flat-public-error',
        headers: { 'x-viventium-scheduler-secret': 'scheduler_secret' },
        query: { userId: 'user_1' },
      });
      const res = createMockRes();

      await dispatch(app, req, res);

      const errorFrame = res.write.mock.calls
        .map(([value]) => value)
        .find((value) => value.startsWith('event: error\ndata: '));
      expect(JSON.parse(errorFrame.slice('event: error\ndata: '.length))).toEqual({
        error: 'The model provider credentials were rejected.',
        error_class: 'provider_unauthorized',
      });
    },
  );

  test.each(['stream', 'events'])(
    'redacts upstream provider details from final %s scheduled failure events',
    async (endpoint) => {
      const privateDetail = 'synthetic-final-provider-secret-never-publish';
      mockSubscribe = jest.fn().mockImplementation(async (_streamId, _onChunk, onDone) => {
        onDone({
          final: true,
          responseMessage: {
            messageId: 'msg-private-provider-failure',
            content: [
              {
                type: 'error',
                error: 'Raw upstream response ' + privateDetail,
                error_class: 'provider_unauthorized',
                response: { body: privateDetail },
              },
            ],
          },
        });
        return { unsubscribe: jest.fn() };
      });
      const schedulerRouter = require('../scheduler');
      const app = createTestApp(schedulerRouter);
      const req = createMockReq({
        method: 'GET',
        url: '/api/viventium/scheduler/' + endpoint + '/scheduler-private-final',
        headers: { 'x-viventium-scheduler-secret': 'scheduler_secret' },
        query: { userId: 'user_1' },
      });
      const res = createMockRes();

      await dispatch(app, req, res);

      const writes = res.write.mock.calls.map((call) => call[0]).join('\n');
      expect(writes).toContain('"error_class":"provider_unauthorized"');
      expect(writes).not.toContain(privateDetail);
    },
  );

  test('preserves exact provider failure class and retry truth in scheduler event receipts', async () => {
    mockSubscribe = jest.fn().mockImplementation(async (_streamId, _onChunk, onDone) => {
      onDone({
        final: true,
        responseMessage: {
          messageId: 'msg-provider-failure',
          content: [
            {
              type: 'error',
              error: 'The selected model provider quota is exhausted.',
              error_class: 'provider_quota_exhausted',
              failure_retryable: false,
              failure_contract_version: 1,
            },
          ],
        },
      });
      return { unsubscribe: jest.fn() };
    });
    const schedulerRouter = require('../scheduler');
    const app = createTestApp(schedulerRouter);
    const req = createMockReq({
      method: 'GET',
      url: '/api/viventium/scheduler/events/scheduler-1',
      headers: { 'x-viventium-scheduler-secret': 'scheduler_secret' },
      query: { userId: 'user_1' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    const writes = res.write.mock.calls.map(([value]) => value).join('\n');
    expect(writes).toContain('event: error');
    expect(writes).toContain('"error_class":"provider_quota_exhausted"');
    expect(writes).toContain('"failure_retryable":false');
    expect(writes).not.toContain('completion_error');
  });

  test('includes only the actual server-authored winning route in the final scheduler receipt', async () => {
    mockSubscribe = jest.fn().mockImplementation(async (_streamId, _onChunk, onDone) => {
      onDone({
        final: true,
        responseMessage: {
          messageId: 'msg-scheduled-success',
          text: 'One scheduled Main answer.',
          metadata: {
            viventium: {
              scheduledExecution: {
                version: 1,
                provider: 'claude-code',
                model: 'opus',
                reasoningEffort: 'high',
                fallbackUsed: true,
                fallbackReason: 'provider_quota_exhausted',
              },
            },
          },
        },
      });
      return { unsubscribe: jest.fn() };
    });
    const schedulerRouter = require('../scheduler');
    const app = createTestApp(schedulerRouter);
    const req = createMockReq({
      method: 'GET',
      url: '/api/viventium/scheduler/events/scheduler-1',
      headers: { 'x-viventium-scheduler-secret': 'scheduler_secret' },
      query: { userId: 'user_1' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    const writes = res.write.mock.calls.map(([value]) => value).join('\n');
    expect(writes).toContain('event: done');
    expect(writes).toContain('"provider":"claude-code"');
    expect(writes).toContain('"model":"opus"');
    expect(writes).toContain('"reasoningEffort":"high"');
    expect(writes).toContain('"fallbackUsed":true');
    expect(writes).toContain('"fallbackReason":"provider_quota_exhausted"');
  });

  test('records the configured Main primary without leaking a stale fallback reason', async () => {
    mockSubscribe = jest.fn().mockImplementation(async (_streamId, _onChunk, onDone) => {
      onDone({
        final: true,
        responseMessage: {
          messageId: 'msg-configured-main-primary',
          text: 'Configured Main answer.',
          metadata: {
            viventium: {
              scheduledExecution: {
                version: 1,
                provider: 'xai',
                model: 'grok-4.5',
                reasoningEffort: 'high',
                fallbackUsed: false,
                fallbackReason: 'provider_quota_exhausted',
              },
            },
          },
        },
      });
      return { unsubscribe: jest.fn() };
    });
    const schedulerRouter = require('../scheduler');
    const app = createTestApp(schedulerRouter);
    const req = createMockReq({
      method: 'GET',
      url: '/api/viventium/scheduler/events/scheduler-1',
      headers: { 'x-viventium-scheduler-secret': 'scheduler_secret' },
      query: { userId: 'user_1' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    const writes = res.write.mock.calls.map(([value]) => value).join('\n');
    expect(writes).toContain('"provider":"xai"');
    expect(writes).toContain('"model":"grok-4.5"');
    expect(writes).toContain('"fallbackUsed":false');
    expect(writes).not.toContain('fallbackReason');
  });

  test.each([
    ['missing provider', { version: 1, model: 'grok-4.5', fallbackUsed: false }],
    [
      'untyped fallback decision',
      { version: 1, provider: 'xai', model: 'grok-4.5', fallbackUsed: 'false' },
    ],
  ])('rejects a final scheduler execution receipt with %s', async (_description, execution) => {
    mockSubscribe = jest.fn().mockImplementation(async (_streamId, _onChunk, onDone) => {
      onDone({
        final: true,
        responseMessage: {
          messageId: 'msg-malformed-execution',
          text: 'Configured Main answer.',
          metadata: { viventium: { scheduledExecution: execution } },
        },
      });
      return { unsubscribe: jest.fn() };
    });
    const schedulerRouter = require('../scheduler');
    const app = createTestApp(schedulerRouter);
    const req = createMockReq({
      method: 'GET',
      url: '/api/viventium/scheduler/events/scheduler-1',
      headers: { 'x-viventium-scheduler-secret': 'scheduler_secret' },
      query: { userId: 'user_1' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    const writes = res.write.mock.calls.map(([value]) => value).join('\n');
    expect(writes).toContain('event: done');
    expect(writes).not.toContain('"execution"');
  });

  test('does not subscribe when the client closes during job lookup', async () => {
    let releaseJobLookup;
    let markJobLookupStarted;
    const jobLookupStarted = new Promise((resolve) => {
      markJobLookupStarted = resolve;
    });
    mockGetJob = jest.fn(
      () =>
        new Promise((resolve) => {
          releaseJobLookup = resolve;
          markJobLookupStarted();
        }),
    );
    const schedulerRouter = require('../scheduler');
    const app = createTestApp(schedulerRouter);
    const req = createMockReq({
      method: 'GET',
      url: '/api/viventium/scheduler/stream/closed-during-lookup',
      headers: { 'x-viventium-scheduler-secret': 'scheduler_secret' },
      query: { userId: 'user_1' },
    });
    const res = createMockRes();

    const dispatched = dispatch(app, req, res);
    await jobLookupStarted;
    res.emit('close');
    releaseJobLookup({ metadata: { userId: 'user_1' } });
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockSubscribe).not.toHaveBeenCalled();
    expect(res.flushHeaders).not.toHaveBeenCalled();
    res._resolve();
    await dispatched;
  });

  test('does not subscribe to structured events when the client closes during job lookup', async () => {
    let releaseJobLookup;
    let markJobLookupStarted;
    const jobLookupStarted = new Promise((resolve) => {
      markJobLookupStarted = resolve;
    });
    mockGetJob = jest.fn(
      () =>
        new Promise((resolve) => {
          releaseJobLookup = resolve;
          markJobLookupStarted();
        }),
    );
    const schedulerRouter = require('../scheduler');
    const app = createTestApp(schedulerRouter);
    const req = createMockReq({
      method: 'GET',
      url: '/api/viventium/scheduler/events/closed-during-lookup',
      headers: { 'x-viventium-scheduler-secret': 'scheduler_secret' },
      query: { userId: 'user_1' },
    });
    const res = createMockRes();

    const dispatched = dispatch(app, req, res);
    await jobLookupStarted;
    res.emit('close');
    releaseJobLookup({ metadata: { userId: 'user_1' } });
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockSubscribe).not.toHaveBeenCalled();
    expect(res.flushHeaders).not.toHaveBeenCalled();
    res._resolve();
    await dispatched;
  });

  test('does not write a structured subscription error after close during readiness', async () => {
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
    const schedulerRouter = require('../scheduler');
    const app = createTestApp(schedulerRouter);
    const req = createMockReq({
      method: 'GET',
      url: '/api/viventium/scheduler/events/closed-during-readiness',
      headers: { 'x-viventium-scheduler-secret': 'scheduler_secret' },
      query: { userId: 'user_1' },
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

  test('unsubscribes when a normally completed response closes', async () => {
    const unsubscribe = jest.fn();
    let completeStream;
    mockSubscribe = jest.fn(async (_streamId, _onChunk, onDone) => {
      completeStream = onDone;
      return { unsubscribe };
    });
    const schedulerRouter = require('../scheduler');
    const app = createTestApp(schedulerRouter);
    const req = createMockReq({
      method: 'GET',
      url: '/api/viventium/scheduler/stream/normal-completion',
      headers: { 'x-viventium-scheduler-secret': 'scheduler_secret' },
      query: { userId: 'user_1' },
    });
    const res = createMockRes();

    const dispatched = dispatch(app, req, res);
    await new Promise((resolve) => setImmediate(resolve));
    completeStream({ final: true });
    await dispatched;
    res.emit('close');

    expect(unsubscribe).toHaveBeenCalledTimes(1);
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
    mockGetMessages = jest.fn().mockResolvedValue([{ messageId: 'fu-1', text: 'Follow-up text' }]);
    mockGetConvo = jest.fn().mockResolvedValue(null);
    mockResolveTelegramMappingByUserId = jest.fn().mockResolvedValue({ telegramUserId: 'tg-1' });
    mockGetAgent = jest.fn().mockResolvedValue({ avatar: { filepath: '/images/viventium.png' } });
    mockGetJob = jest.fn().mockResolvedValue({ metadata: { userId: 'user_1' } });
    mockGetResumeState = jest.fn().mockResolvedValue(null);
    mockSubscribe = jest.fn().mockResolvedValue({ unsubscribe: jest.fn() });
    mockGetCortexInsightDeliveriesForParent = jest.fn().mockResolvedValue([]);
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
    mockGetMessages = jest
      .fn()
      .mockResolvedValue([{ messageId: 'msg-3', text: 'Canonical replacement text' }]);

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
