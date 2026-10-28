/* === VIVENTIUM START ===
 * Feature: LibreChat Telegram Bridge - /api/viventium/telegram tests
 * Added: 2026-01-13
 * === VIVENTIUM END === */

const express = require('express');
const crypto = require('crypto');
const { Readable } = require('stream');
const { EventEmitter } = require('events');
const fs = require('fs');
const { createParallelWorkReleaseFixture } = require('../testFixtures/parallelWorkReleaseFixture');

const releaseFixture = createParallelWorkReleaseFixture('viventium-telegram-release-gate-');
const { openGate, releaseDir, releasePath, validGates, writeReleaseSnapshot } = releaseFixture;
let lastAgentId = null;
let mockGetPersistedJob = jest.fn().mockResolvedValue(null);
let lastStreamId = null;
let lastParentMessageId = null;
let lastSpec = null;
let lastVoiceProvider = null;
let lastVoiceMode = null;
let lastTelegramAudioRequested = null;
let lastTelegramImages = null;
let lastMissionAttachments = null;
let lastBridgeDocumentImageExtraction = null;
let mockLastInteractionContext = null;
let mockInputService;
let mockSaveInput;
let mockInputMessageUpdate;
let mockInputMessageRead;
let mockInputSourceHistory;
let mockReplyReceiptFindOne;
let mockRetainLogicalTurnInput;
let mockMutateNativeResponseSources;
let mockLastPreparedBody;
let mockCaptureAcceptedInteractionInput;
let mockRetainAcceptedInteractionInput;
let mockLastAdapterCapabilities = null;
let mockLastDeliveryPolicy = null;
let mockClaimedLogicalTurn = null;
let mockAfterAdmission;
let mockUserFindOne;
let mockUserCountDocuments;
let mockSubscribe;
let mockGetJob;
let mockGetResumeState;
let mockObserveSourceOrder;
let mockGetSourceOrderCapabilities;
let mockGetMessages;
let mockGetMessage;
let mockGetConvo;
let mockGetAgent;
let mockResolveUserVoiceRoute;
let mockResolveVoiceContextKeyterms;
let mockTelegramMappingFindOne;
let mockTelegramMappingUpdateOne;
let mockTelegramLinkTokenCreate;
let mockTelegramIngressCreate;
let mockTelegramIngressFindOne;
let mockTelegramIngressExists;
let mockTelegramIngressUpdateOne;
let mockTelegramIngressDeleteOne;
let mockFileAccess;
let mockGetStrategyFunctions;
let mockLoadAuthValues;
let mockCreateCallSession;
let mockCreateCallBrowserLaunch;
let mockAssertVoiceAgentAccess;
let mockFilterFile;
let mockProcessAgentFileUpload;
let mockClaimGlassHiveDeliveries;
let mockAuthorizeGlassHiveDeliveryDispatch;
let mockRenewGlassHiveDeliveryDispatch;
let mockReleaseGlassHiveDeliveryDispatch;
let mockMarkGlassHiveDeliverySent;
let mockMarkGlassHiveDeliveryFailed;
let mockMarkGlassHiveDeliverySuppressed;
let mockMarkGlassHiveDeliveryUnknown;
let mockDeliveryBacklogSummary;
let mockGetUserById;
let mockUpdateOrchestrationPreferences;
let mockGetActiveWorkPage;
let mockGetActiveWorkInteractiveSnapshot;
let mockGetActiveWorkSnapshot;
let mockRequestAccountApi;
let mockBuildTrustedActionIdempotencyKey;
let mockInvalidateActiveWorkSnapshot;
let mockDismissCoreOnlyPreDispatchAttention;
let mockGetCoreWorkDelivery;
let mockGetCoreWorkOriginRef;
let mockReauthorizeCapabilityAuthorization;
let mockRefreshOrchestrationReadiness;
let mockAuthoringOrchestrationReadiness;
let mockGetCortexInsightDeliveriesForParent;
let mockClaimCortexTelegramDeliveries;
let mockAuthorizeCortexTelegramDeliveryClaim;
let mockFailCortexTelegramDeliveryClaim;
let mockSuppressCortexTelegramDeliveryClaim;
let mockMarkCortexTelegramDeliveryUnknown;

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

jest.mock('~/server/controllers/agents/request', () => {
  const mockAgentController = async (req, res) => {
    const {
      bindLogicalTurnContext,
      getTrustedAdapterCapabilities,
      getTrustedDeliveryPolicy,
      getTrustedInteractionContext,
    } = require('~/server/services/viventium/interactionContext');
    mockLastInteractionContext = getTrustedInteractionContext(req);
    mockLastAdapterCapabilities = getTrustedAdapterCapabilities(req);
    mockLastDeliveryPolicy = getTrustedDeliveryPolicy(req);
    if (mockClaimedLogicalTurn) {
      bindLogicalTurnContext(req, { ...mockLastInteractionContext, ...mockClaimedLogicalTurn });
    }
    lastAgentId = req.body.agent_id;
    lastStreamId = req.body.streamId;
    lastParentMessageId = req.body.parentMessageId;
    mockLastPreparedBody = { ...req.body };
    lastSpec = req.body.spec;
    lastVoiceProvider = req.body.voiceProvider || null;
    lastVoiceMode = req.body.voiceMode ?? null;
    lastTelegramAudioRequested = req.body.telegramAudioRequested ?? null;
    lastTelegramImages = req._telegramImages || null;
    lastMissionAttachments = req._viventiumMissionAttachments || null;
    lastBridgeDocumentImageExtraction = req._viventiumBridgeDocumentImageExtraction;
    await req._viventiumBeforeGenerationReceipt?.({ streamId: 'stream_1' });
    await mockAfterAdmission?.(req, getTrustedInteractionContext(req));
    res.json({
      streamId: 'stream_1',
      conversationId: mockAgentController.__testables.resolveCanonicalConversationId(
        req,
        req.user?.id,
        req.body.conversationId || 'new',
      ),
    });
  };
  mockAgentController.__testables = {
    resolveCanonicalConversationId: (_req, _userId, requestedConversationId) =>
      requestedConversationId === 'new'
        ? '11111111-1111-5111-8111-111111111111'
        : requestedConversationId,
  };
  mockAgentController.resolveCanonicalConversationId =
    mockAgentController.__testables.resolveCanonicalConversationId;
  mockAgentController.acceptedInteractionSourceId = jest.fn(() => 'source-message');
  mockAgentController.captureAcceptedInteractionInput = (...args) =>
    mockCaptureAcceptedInteractionInput(...args);
  mockAgentController.retainAcceptedInteractionInput = (...args) =>
    mockRetainAcceptedInteractionInput(...args);
  return mockAgentController;
});

jest.mock('~/server/services/Endpoints/agents', () => ({
  initializeClient: jest.fn(),
}));

jest.mock('~/server/services/Endpoints/agents/title', () => jest.fn());

jest.mock(
  '~/server/services/viventium/TelegramInputService',
  () =>
    new Proxy(
      {},
      {
        get:
          (_target, key) =>
          (...args) =>
            mockInputService[key](...args),
      },
    ),
);
const mockReadHostFinal = jest.fn(async () => null);
const mockForegroundAttention = jest.fn();
const mockForegroundCancel = jest.fn();
jest.mock('~/server/services/viventium/nativeResponseService', () => ({
  readRetainedHostFinal: (...args) => mockReadHostFinal(...args),
  readRetainedMainFinal: (...args) => mockReadHostFinal(...args),
  mutateNativeResponseSources: (...args) => mockMutateNativeResponseSources(...args),
  getForegroundAttentionControl: () => ({
    attention: (...args) => mockForegroundAttention(...args),
    cancel: (...args) => mockForegroundCancel(...args),
  }),
}));

jest.mock('~/models', () => ({
  getUserById: (...args) => mockGetUserById(...args),
  updateUserViventiumOrchestrationPreferences: (...args) =>
    mockUpdateOrchestrationPreferences(...args),
  getMessages: (...args) => mockGetMessages(...args),
  getMessage: (...args) => mockGetMessage(...args),
  getConvo: (...args) => mockGetConvo(...args),
  saveMessage: (...args) => mockSaveInput(...args),
  getFiles: async () => [],
}));

jest.mock('~/server/services/viventium/GlassHiveAccountService', () => ({
  getActiveWorkPage: (...args) => mockGetActiveWorkPage(...args),
  getActiveWorkInteractiveSnapshot: (...args) => mockGetActiveWorkInteractiveSnapshot(...args),
  getActiveWorkSnapshot: (...args) => mockGetActiveWorkSnapshot(...args),
  requestAccountApi: (...args) => mockRequestAccountApi(...args),
  buildTrustedActionIdempotencyKey: (...args) => mockBuildTrustedActionIdempotencyKey(...args),
  invalidateActiveWorkSnapshot: (...args) => mockInvalidateActiveWorkSnapshot(...args),
}));

jest.mock('~/server/services/viventium/GlassHiveCapabilityAuthorizationService', () => ({
  reauthorizeCapabilityAuthorization: (...args) => mockReauthorizeCapabilityAuthorization(...args),
}));

jest.mock('~/server/services/viventium/GlassHiveActiveWorkProjectionService', () => ({
  dismissCoreOnlyPreDispatchAttention: (...args) =>
    mockDismissCoreOnlyPreDispatchAttention(...args),
  getCoreWorkDelivery: (...args) => mockGetCoreWorkDelivery(...args),
  getCoreWorkOriginRef: (...args) => mockGetCoreWorkOriginRef(...args),
}));

jest.mock('~/server/services/viventium/GlassHiveOrchestrationReadinessService', () => ({
  observeOrchestrationOwner: jest.fn(() => ({
    available: process.env.VIVENTIUM_PARALLEL_WORK_AVAILABLE === 'true',
  })),
  orchestrationReadinessSnapshot: jest.fn(() => ({
    requested: process.env.VIVENTIUM_PARALLEL_WORK_AVAILABLE === 'true',
    available: process.env.VIVENTIUM_PARALLEL_WORK_AVAILABLE === 'true',
  })),
  refreshOrchestrationReadiness: (...args) => mockRefreshOrchestrationReadiness(...args),
  authoringOrchestrationReadiness: (...args) => mockAuthoringOrchestrationReadiness(...args),
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

jest.mock('~/server/services/viventium/CallSessionService', () => ({
  createCallBrowserLaunch: (...args) => mockCreateCallBrowserLaunch(...args),
  createCallSession: (...args) => mockCreateCallSession(...args),
  resolveUserVoiceRoute: (...args) => mockResolveUserVoiceRoute(...args),
  resolveVoiceContextKeyterms: (...args) => mockResolveVoiceContextKeyterms(...args),
}));

jest.mock('~/server/services/viventium/VoiceAgentAuthorizationService', () => ({
  assertVoiceAgentAccess: (...args) => mockAssertVoiceAgentAccess(...args),
}));

jest.mock('~/server/services/viventium/GlassHiveCallbackDeliveryService', () => ({
  authorizeGlassHiveCallbackDeliveryDispatch: (...args) =>
    mockAuthorizeGlassHiveDeliveryDispatch(...args),
  claimPendingGlassHiveCallbackDeliveries: (...args) => mockClaimGlassHiveDeliveries(...args),
  markGlassHiveCallbackDeliverySent: (...args) => mockMarkGlassHiveDeliverySent(...args),
  markGlassHiveCallbackDeliveryFailed: (...args) => mockMarkGlassHiveDeliveryFailed(...args),
  markGlassHiveCallbackDeliverySuppressed: (...args) =>
    mockMarkGlassHiveDeliverySuppressed(...args),
  markGlassHiveCallbackDeliveryUnknown: (...args) => mockMarkGlassHiveDeliveryUnknown(...args),
  releaseGlassHiveCallbackDeliveryDispatch: (...args) =>
    mockReleaseGlassHiveDeliveryDispatch(...args),
  renewGlassHiveCallbackDeliveryDispatch: (...args) => mockRenewGlassHiveDeliveryDispatch(...args),
  deliveryBacklogSummary: (...args) => mockDeliveryBacklogSummary(...args),
}));

jest.mock('~/server/services/viventium/CortexInsightDeliveryService', () => ({
  getCortexInsightDeliveriesForParent: (...args) =>
    mockGetCortexInsightDeliveriesForParent(...args),
}));

jest.mock('~/server/services/viventium/CortexTelegramDeliveryDispatchService', () => ({
  claimPendingCortexTelegramDeliveries: (...args) => mockClaimCortexTelegramDeliveries(...args),
  authorizeCortexTelegramDeliveryClaim: (...args) =>
    mockAuthorizeCortexTelegramDeliveryClaim(...args),
  failCortexTelegramDeliveryClaim: (...args) => mockFailCortexTelegramDeliveryClaim(...args),
  suppressCortexTelegramDeliveryClaim: (...args) =>
    mockSuppressCortexTelegramDeliveryClaim(...args),
  markCortexTelegramDeliveryUnknown: (...args) => mockMarkCortexTelegramDeliveryUnknown(...args),
}));

jest.mock('~/models/Agent', () => ({
  getAgent: (...args) => mockGetAgent(...args),
}));

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  GenerationJobManager: {
    getJob: (...args) => mockGetJob(...args),
    getJobStore: () => ({ getJob: (...args) => mockGetPersistedJob(...args) }),
    getResumeState: (...args) => mockGetResumeState(...args),
    observeSourceOrder: (...args) => mockObserveSourceOrder(...args),
    getSourceOrderCapabilities: (...args) => mockGetSourceOrderCapabilities(...args),
    subscribe: (...args) => mockSubscribe(...args),
    retainLogicalTurnInput: (...args) => mockRetainLogicalTurnInput(...args),
  },
}));

jest.mock('~/db/models', () => ({
  Message: {
    findOne: (...args) => mockInputMessageRead(...args),
    find: (...args) => ({ select: () => ({ lean: () => mockInputSourceHistory(...args) }) }),
    exists: jest.fn().mockResolvedValue(false),
    updateOne: (...args) => mockInputMessageUpdate(...args),
  },
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
    findOne: (...args) => mockTelegramIngressFindOne(...args),
    exists: (...args) => mockTelegramIngressExists(...args),
    create: (...args) => mockTelegramIngressCreate(...args),
    updateOne: (...args) => mockTelegramIngressUpdateOne(...args),
    deleteOne: (...args) => mockTelegramIngressDeleteOne(...args),
  },
  ViventiumGlassHiveCallbackDelivery: {
    findOne: (...args) => mockReplyReceiptFindOne(...args),
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

function createMockReq({
  method = 'POST',
  url,
  headers = {},
  body = {},
  query = {},
  withTrustedSourceIdentity = true,
} = {}) {
  const normalized = {};
  Object.entries(headers).forEach(([key, value]) => {
    normalized[key.toLowerCase()] = value;
  });
  let path = url.split('?')[0];
  const basePrefix = '/api/viventium/telegram';
  if (path.startsWith(basePrefix)) {
    path = path.slice(basePrefix.length) || '/';
  }
  let normalizedBody = body;
  if (path === '/chat' && withTrustedSourceIdentity && body.telegramUserId) {
    const telegramUserId = body.telegramUserId;
    const telegramChatId = body.telegramChatId ?? '-100123';
    const telegramMessageId = body.telegramMessageId ?? '42';
    const telegramMessageThreadId = body.telegramMessageThreadId ?? '';
    const sourceOrderScope =
      body.sourceOrderScope ??
      trustedTelegramSourceScope({
        telegramUserId,
        telegramChatId,
        telegramMessageThreadId,
      });
    normalizedBody = {
      telegramChatId,
      telegramMessageId,
      telegramMessageThreadId,
      sourceOrderScope,
      sourceEventId:
        body.sourceEventId ??
        trustedTelegramSourceEventId({
          sourceOrderScope,
          sourceSequence: Number(telegramMessageId),
        }),
      ...body,
    };
  }

  return {
    method,
    url,
    originalUrl: url,
    path,
    headers: normalized,
    body: normalizedBody,
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

function trustedTelegramSourceScope({
  ownerId = 'user_1',
  telegramUserId = 'tg-1',
  telegramChatId = '-100123',
  telegramMessageThreadId = '',
} = {}) {
  const {
    buildTelegramSourceOrderScope,
  } = require('~/server/services/viventium/interactionContext');
  return buildTelegramSourceOrderScope({
    librechat_owner_id: ownerId,
    telegram_user_id: telegramUserId,
    telegram_chat_id: telegramChatId,
    message_thread_id: telegramMessageThreadId,
    source_domain: 'telegram-interactive-v1',
  });
}

function trustedTelegramSourceEventId({
  sourceOrderScope = trustedTelegramSourceScope(),
  sourceSequence = 42,
} = {}) {
  return crypto
    .createHash('sha256')
    .update(
      ['viventium.telegram-source-event.v1', sourceOrderScope, String(sourceSequence)].join('\0'),
    )
    .digest('hex');
}

describe('/api/viventium/telegram', () => {
  beforeEach(() => {
    mockForegroundAttention.mockReset();
    mockForegroundCancel.mockReset();
    mockReadHostFinal.mockReset().mockResolvedValue(null);
    mockInputService = {
      resolvePendingConversation: jest.fn().mockResolvedValue(null),
      read: jest.fn(),
      register: jest.fn(),
      ready: jest.fn(),
      bindStream: jest.fn().mockResolvedValue(undefined),
      status: jest.fn(),
      claimPending: jest.fn(),
      inputEnvelope: jest.fn(),
      readPrepared: jest.fn(),
      messageFilter: jest.fn().mockReturnValue({ messageId: 'source-message' }),
      hasEarlierPreparingInput: jest.fn().mockResolvedValue(false),
      hasNewerUnresolvedInput: jest.fn().mockResolvedValue(false),
      hasNewerCompletedInput: jest.fn().mockResolvedValue(false),
      hasNewerFailedAdmittedInput: jest.fn().mockResolvedValue(false),
      hasCommittedDelivery: jest.fn().mockResolvedValue(false),
      defer: jest.fn().mockResolvedValue(undefined),
    };
    mockRetainLogicalTurnInput = jest.fn().mockResolvedValue({});
    mockReplyReceiptFindOne = jest.fn(() => ({ lean: async () => null }));
    mockMutateNativeResponseSources = jest.fn(async (_filter, operation) => operation());
    mockSaveInput = jest.fn().mockResolvedValue({});
    mockInputMessageRead = jest.fn(() => ({ select: () => ({ lean: async () => null }) }));
    mockInputSourceHistory = jest.fn().mockResolvedValue([]);
    mockInputMessageUpdate = jest.fn().mockResolvedValue({ matchedCount: 1 });
    mockLastPreparedBody = null;
    lastAgentId = null;
    lastStreamId = null;
    lastParentMessageId = null;
    lastSpec = null;
    lastVoiceProvider = null;
    lastVoiceMode = null;
    lastTelegramAudioRequested = null;
    lastTelegramImages = null;
    lastMissionAttachments = null;
    lastBridgeDocumentImageExtraction = null;
    mockLastInteractionContext = null;
    mockLastAdapterCapabilities = null;
    mockLastDeliveryPolicy = null;
    mockClaimedLogicalTurn = null;
    mockAfterAdmission = undefined;
    mockCaptureAcceptedInteractionInput = jest.fn().mockResolvedValue(undefined);
    mockRetainAcceptedInteractionInput = jest.fn().mockResolvedValue(undefined);
    jest.resetModules();
    mockUserFindOne = jest.fn();
    mockUserCountDocuments = jest.fn().mockResolvedValue(0);
    mockSubscribe = jest.fn();
    mockGetJob = jest.fn().mockResolvedValue({ metadata: { userId: 'user_1' } });
    mockGetPersistedJob = jest.fn().mockResolvedValue(null);
    mockGetResumeState = jest.fn().mockResolvedValue(null);
    mockObserveSourceOrder = jest.fn().mockResolvedValue({
      latest_source_sequence: 12347,
      observed_at: 1_725_000_000_000,
      stale: false,
    });
    mockGetSourceOrderCapabilities = jest.fn().mockReturnValue({
      durability: 'durable',
      replica_safe: true,
    });
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
      browserCapability: 'B'.repeat(43),
    }));
    mockCreateCallBrowserLaunch = jest.fn().mockResolvedValue({ capability: 'B'.repeat(43) });
    mockAssertVoiceAgentAccess = jest.fn().mockResolvedValue({ _id: 'agent-resource-1' });
    mockResolveUserVoiceRoute = jest.fn().mockResolvedValue({
      stt: { provider: 'pywhispercpp', variant: 'base.en' },
      tts: {
        provider: 'local_chatterbox_turbo_mlx_8bit',
        variant: 'mlx-community/chatterbox-turbo-8bit',
      },
    });
    mockResolveVoiceContextKeyterms = jest.fn().mockResolvedValue([]);
    mockClaimGlassHiveDeliveries = jest.fn().mockResolvedValue([]);
    mockAuthorizeGlassHiveDeliveryDispatch = jest.fn().mockResolvedValue({
      deliveryId: 'ghcd_1',
      claimId: 'claim-1',
      surface: 'telegram',
      permitId: 'a'.repeat(32),
      permitGeneration: 2,
      expiresAt: '2026-08-23T20:00:00.000Z',
      resultRevision: 2,
      resultDigest: `sha256:${'b'.repeat(64)}`,
    });
    mockRenewGlassHiveDeliveryDispatch = jest.fn().mockResolvedValue({
      deliveryId: 'ghcd_1',
      claimId: 'claim-1',
      surface: 'telegram',
      permitId: 'a'.repeat(32),
      permitGeneration: 2,
      expiresAt: '2026-08-23T20:01:00.000Z',
      resultRevision: 2,
      resultDigest: `sha256:${'b'.repeat(64)}`,
    });
    mockReleaseGlassHiveDeliveryDispatch = jest.fn().mockResolvedValue(true);
    mockMarkGlassHiveDeliverySent = jest.fn().mockResolvedValue({ deliveryId: 'ghcd_1' });
    mockMarkGlassHiveDeliveryFailed = jest.fn().mockResolvedValue({ deliveryId: 'ghcd_1' });
    mockMarkGlassHiveDeliverySuppressed = jest.fn().mockResolvedValue({ deliveryId: 'ghcd_1' });
    mockMarkGlassHiveDeliveryUnknown = jest.fn().mockResolvedValue({ deliveryId: 'ghcd_1' });
    mockDeliveryBacklogSummary = jest.fn().mockResolvedValue({ count: 0, oldest: null });
    mockGetUserById = jest.fn().mockResolvedValue({
      _id: 'user_1',
      role: 'USER',
      personalization: { orchestration_mode: 'focused' },
    });
    mockUpdateOrchestrationPreferences = jest.fn().mockResolvedValue({
      _id: 'user_1',
      role: 'USER',
      personalization: { orchestration_mode: 'parallel' },
    });
    mockGetActiveWorkInteractiveSnapshot = jest.fn().mockResolvedValue({
      snapshot: 'fresh',
      work: [],
      overflowCount: 0,
    });
    mockGetActiveWorkSnapshot = jest.fn().mockResolvedValue({
      snapshot: 'fresh',
      work: [],
      overflowCount: 0,
    });
    mockGetActiveWorkPage = jest.fn().mockResolvedValue({
      snapshot: 'fresh',
      work: [{ workRef: 'work-next', state: 'running', actions: [] }],
      overflowCount: 0,
    });
    mockRequestAccountApi = jest.fn().mockResolvedValue({
      workRef: 'ghw_test',
      state: 'stopping',
    });
    mockBuildTrustedActionIdempotencyKey = jest.fn().mockReturnValue('trusted-action-key');
    mockInvalidateActiveWorkSnapshot = jest.fn();
    mockDismissCoreOnlyPreDispatchAttention = jest.fn().mockResolvedValue(null);
    mockGetCoreWorkDelivery = jest.fn().mockResolvedValue({ state: 'delivered' });
    mockGetCoreWorkOriginRef = jest.fn().mockResolvedValue('ghi_original_telegram_launch');
    mockRefreshOrchestrationReadiness = jest.fn().mockResolvedValue({ available: false });
    mockAuthoringOrchestrationReadiness = jest.fn().mockResolvedValue({
      requested: true,
      available: true,
      status: 'ready',
      reason: '',
    });
    mockGetCortexInsightDeliveriesForParent = jest.fn().mockResolvedValue([]);
    mockReauthorizeCapabilityAuthorization = jest.fn().mockResolvedValue({
      authorizationRef: 'gha_authorization',
      maxExpiresAt: '2026-08-14T00:00:00.000Z',
      scopeFingerprint: 'scope-fingerprint',
    });
    mockFailCortexTelegramDeliveryClaim = jest.fn().mockResolvedValue([{ deliveryId: 'cidl-1' }]);
    mockSuppressCortexTelegramDeliveryClaim = jest
      .fn()
      .mockResolvedValue([{ deliveryId: 'cidl-1' }]);
    mockMarkCortexTelegramDeliveryUnknown = jest.fn().mockResolvedValue([{ deliveryId: 'cidl-1' }]);
    mockTelegramMappingFindOne = jest.fn().mockReturnValue({
      lean: async () => ({ libreChatUserId: 'user_1' }),
    });
    mockTelegramMappingUpdateOne = jest.fn().mockResolvedValue({});
    mockTelegramLinkTokenCreate = jest.fn().mockResolvedValue({});
    mockTelegramIngressFindOne = jest.fn(() => ({ lean: async () => null }));
    mockTelegramIngressExists = jest.fn().mockResolvedValue(true);
    mockTelegramIngressCreate = jest.fn().mockResolvedValue({ _id: 'ingress_1' });
    mockTelegramIngressUpdateOne = jest.fn().mockResolvedValue({
      acknowledged: true,
      matchedCount: 1,
      modifiedCount: 1,
    });
    mockTelegramIngressDeleteOne = jest.fn().mockResolvedValue({});
    mockClaimCortexTelegramDeliveries = jest.fn().mockResolvedValue([]);
    mockAuthorizeCortexTelegramDeliveryClaim = jest.fn().mockResolvedValue({
      ownerId: 'owner-1',
      messageId: 'followup-1',
      parentMessageId: 'parent-1',
      revision: 2,
      generation: 3,
      deliveryIds: ['cidl-1'],
      deliveryReceipts: [{ deliveryId: 'cidl-1', graphResultHash: 'a'.repeat(64) }],
      claimToken: 'claim-3',
      presentationLeaseToken: 'lease-3',
      surface: 'telegram',
    });
    mockFailCortexTelegramDeliveryClaim = jest.fn().mockResolvedValue([{ deliveryId: 'cidl-1' }]);
    mockSuppressCortexTelegramDeliveryClaim = jest
      .fn()
      .mockResolvedValue([{ deliveryId: 'cidl-1' }]);
    mockMarkCortexTelegramDeliveryUnknown = jest.fn().mockResolvedValue([{ deliveryId: 'cidl-1' }]);
    process.env.VIVENTIUM_TELEGRAM_SECRET = 'telegram_secret';
    process.env.DOMAIN_SERVER = 'http://example.com';
    process.env.VIVENTIUM_PLAYGROUND_URL = 'http://localhost:3300';
    process.env.VIVENTIUM_PUBLIC_PLAYGROUND_URL = '';
    process.env.VIVENTIUM_VOICE_GATEWAY_AGENT_NAME = 'librechat-voice-gateway';
    process.env.VIVENTIUM_PARALLEL_WORK_AVAILABLE = 'true';
    process.env.VIVENTIUM_PARALLEL_WORK_RELEASE_GATE_FILE = releasePath;
    process.env.VIVENTIUM_RUNTIME_DIR = releaseDir;
    delete process.env.VIVENTIUM_TELEGRAM_CONVERSATION_IDLE_MAX_M;
    releaseFixture.reset();
  });

  afterAll(() => {
    releaseFixture.cleanup();
  });

  test.each(['attention', 'cancel'])(
    'foreground %s binds linked owner and chat/thread scope',
    async (action) => {
      const expected = { version: 1, state: 'cancelled', capacityReleased: true };
      mockForegroundAttention.mockResolvedValue(expected);
      mockForegroundCancel.mockResolvedValue(expected);
      const req = createMockReq({
        method: action === 'attention' ? 'GET' : 'POST',
        url: `/api/viventium/telegram/foreground/failed-answer/${action}`,
        headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
        query: {
          telegramUserId: 'tg-1',
          telegramChatId: '-100123',
          telegramMessageThreadId: '77',
          conversationId: 'conversation-a',
          ownerId: 'forged-owner',
        },
        body: { receipt: 'a'.repeat(64), operationId: 'operation-a', ownerId: 'forged-owner' },
      });
      const res = createMockRes();
      await dispatch(createTestApp(require('../telegram')), req, res);
      expect(res.statusCode).toBe(200);
      const target = action === 'attention' ? mockForegroundAttention : mockForegroundCancel;
      expect(res.headers['Cache-Control']).toBe('no-store, private');
      expect(target.mock.calls[0][0]).toEqual({
        ownerId: 'user_1',
        conversationId: 'conversation-a',
        responseMessageId: 'failed-answer',
        sourceOrderScope: trustedTelegramSourceScope({ telegramMessageThreadId: '77' }),
      });
      if (action === 'cancel')
        expect(target.mock.calls[0][1]).toEqual({
          receipt: 'a'.repeat(64),
          operationId: 'operation-a',
        });
    },
  );

  test.each([undefined, ''])(
    'foreground attention preserves the normal empty thread %s',
    async (threadId) => {
      mockForegroundAttention.mockResolvedValue({ version: 1 });
      const req = createMockReq({
        method: 'GET',
        url: '/api/viventium/telegram/foreground/failed-answer/attention',
        headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
        query: {
          telegramUserId: 'tg-1',
          telegramChatId: '-100123',
          conversationId: 'conversation-a',
          ...(threadId === undefined ? {} : { telegramMessageThreadId: threadId }),
        },
      });
      const res = createMockRes();
      await dispatch(createTestApp(require('../telegram')), req, res);
      expect(res.statusCode).toBe(200);
      expect(mockForegroundAttention.mock.calls[0][0].sourceOrderScope).toBe(
        trustedTelegramSourceScope(),
      );
    },
  );

  test('foreground cancel rejects unauthenticated control before the native adapter', async () => {
    const req = createMockReq({
      url: '/api/viventium/telegram/foreground/failed-answer/cancel',
      query: { telegramUserId: 'tg-1', telegramChatId: '-100123' },
    });
    const res = createMockRes();
    await dispatch(createTestApp(require('../telegram')), req, res);
    expect(res.statusCode).toBe(401);
    expect(mockForegroundCancel).not.toHaveBeenCalled();
  });

  test('POST /source-order binds the authenticated owner and ignores caller owner claims', async () => {
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);
    const req = createMockReq({
      url: '/api/viventium/telegram/source-order',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      body: {
        telegramUserId: 'tg-1',
        telegramChatId: '-100123',
        telegramMessageThreadId: '77',
        sourceSequence: 12347,
        ownerId: 'forged-owner',
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(mockObserveSourceOrder).toHaveBeenCalledWith({
      source_order_scope: expect.stringMatching(/^[a-f0-9]{64}$/),
      source_sequence: 12347,
    });
    expect(res.body).toEqual({
      observed: true,
      sourceOrderScope: expect.stringMatching(/^[a-f0-9]{64}$/),
      sourceEventId: expect.stringMatching(/^[a-f0-9]{64}$/),
      latestSourceSequence: 12347,
      observedAt: 1_725_000_000_000,
      stale: false,
      durability: 'durable',
      replicaSafe: true,
    });
  });

  test('POST /source-order does not revalidate the release snapshot on the durable fast path', async () => {
    const childProcess = require('child_process');
    const execFileSyncSpy = jest.spyOn(childProcess, 'execFileSync');
    try {
      const telegramRouter = require('../telegram');
      const app = createTestApp(telegramRouter);
      const req = createMockReq({
        url: '/api/viventium/telegram/source-order',
        headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
        body: {
          telegramUserId: 'tg-1',
          telegramChatId: '-100123',
          sourceSequence: 12347,
        },
      });
      const res = createMockRes();
      execFileSyncSpy.mockClear();

      await dispatch(app, req, res);

      expect(res.statusCode).toBe(200);
      expect(mockObserveSourceOrder).toHaveBeenCalledTimes(1);
      expect(execFileSyncSpy).not.toHaveBeenCalled();
    } finally {
      execFileSyncSpy.mockRestore();
    }
  });

  test('POST /source-order isolates shared-topic senders and a relinked LibreChat owner', async () => {
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);
    const observedScopes = [];
    mockObserveSourceOrder.mockImplementation(async (observation) => {
      observedScopes.push(observation.source_order_scope);
      return {
        latest_source_sequence: observation.source_sequence,
        observed_at: 1_725_000_000_000,
        stale: false,
      };
    });
    mockTelegramMappingFindOne.mockImplementation(({ telegramUserId }) => ({
      lean: async () => ({
        libreChatUserId:
          telegramUserId === 'tg-2' ? 'owner-1' : observedScopes.length < 2 ? 'owner-1' : 'owner-2',
      }),
    }));
    mockGetUserById.mockImplementation(async (ownerId) => ({
      _id: ownerId,
      role: 'USER',
      personalization: { orchestration_mode: 'focused' },
    }));

    for (const telegramUserId of ['tg-1', 'tg-2', 'tg-1']) {
      const req = createMockReq({
        url: '/api/viventium/telegram/source-order',
        headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
        body: {
          telegramUserId,
          telegramChatId: '-100123',
          telegramMessageThreadId: '77',
          sourceSequence: 12347 + observedScopes.length,
        },
      });
      await dispatch(app, req, createMockRes());
    }

    expect(observedScopes).toHaveLength(3);
    expect(new Set(observedScopes).size).toBe(3);
  });

  test('POST /source-order fails closed for Parallel mode on a process-local watermark', async () => {
    mockGetUserById.mockResolvedValue({
      _id: 'user_1',
      role: 'USER',
      personalization: { orchestration_mode: 'parallel' },
    });
    mockGetSourceOrderCapabilities.mockReturnValue({
      durability: 'process',
      replica_safe: false,
    });
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);
    const req = createMockReq({
      url: '/api/viventium/telegram/source-order',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      body: {
        telegramUserId: 'tg-1',
        telegramChatId: '-100123',
        sourceSequence: 12347,
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({
      observed: false,
      error: 'durable_source_order_required',
      durability: 'process',
      replicaSafe: false,
    });
    expect(mockObserveSourceOrder).not.toHaveBeenCalled();
  });

  test('POST /source-order permits process-local ordering for focused fallback when Parallel is disabled', async () => {
    process.env.VIVENTIUM_PARALLEL_WORK_AVAILABLE = 'false';
    mockGetUserById.mockResolvedValue({
      _id: 'user_1',
      role: 'USER',
      personalization: { orchestration_mode: 'parallel' },
    });
    mockGetSourceOrderCapabilities.mockReturnValue({
      durability: 'process',
      replica_safe: false,
    });
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);
    const req = createMockReq({
      url: '/api/viventium/telegram/source-order',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      body: {
        telegramUserId: 'tg-1',
        telegramChatId: '-100123',
        sourceSequence: 12347,
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(mockObserveSourceOrder).toHaveBeenCalledTimes(1);
    expect(res.body).toEqual(
      expect.objectContaining({
        observed: true,
        durability: 'process',
        replicaSafe: false,
      }),
    );
  });

  test('POST /source-order rejects unauthenticated observations before touching the watermark', async () => {
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);
    const req = createMockReq({
      url: '/api/viventium/telegram/source-order',
      body: {
        telegramUserId: 'tg-1',
        telegramChatId: '-100123',
        sourceSequence: 12347,
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(401);
    expect(mockObserveSourceOrder).not.toHaveBeenCalled();
  });

  const inputIdentity = () => {
    const {
      buildTelegramSourceOrderScope,
      buildTelegramSourceEventId,
    } = require('~/server/services/viventium/interactionContext');
    const sourceOrderScope = buildTelegramSourceOrderScope({
      librechat_owner_id: 'user_1',
      telegram_user_id: 'tg-1',
      telegram_chat_id: '-100123',
      message_thread_id: '77',
      source_domain: 'telegram-interactive-v1',
    });
    return {
      sourceOrderScope,
      sourceEventId: buildTelegramSourceEventId({
        source_order_scope: sourceOrderScope,
        source_sequence: 12,
      }),
      sourceSequence: 12,
      sourceMessageId: 'source-message',
      conversationGeneration: 'a'.repeat(64),
      conversationId: 'canonical-conversation',
      requestedConversationId: 'new',
      telegramUserId: 'tg-1',
      telegramChatId: '-100123',
      telegramMessageThreadId: '77',
      state: 'preparing',
      claimToken: 'owned-token',
      registrationId: '11111111-1111-4111-8111-111111111111',
      leaseUntil: Date.now() + 120000,
    };
  };
  function retainedSourceRequest(row, input = {}) {
    return createMockReq({
      url: '/api/viventium/telegram/source-order',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      body: {
        telegramUserId: row.telegramUserId,
        telegramChatId: row.telegramChatId,
        telegramMessageThreadId: row.telegramMessageThreadId,
        sourceSequence: row.sourceSequence,
        input: {
          text: 'Original retained request',
          conversationId: 'new',
          conversationGeneration: row.conversationGeneration,
          preparationId: row.registrationId,
          preparation: { version: 1, message: { message_id: row.sourceSequence } },
          ...input,
        },
      },
    });
  }

  test('durable intake retains the exact input before a stalled ordering dependency and recovers without admission', async () => {
    const row = inputIdentity();
    mockInputService.register.mockResolvedValue(row);
    let release;
    mockObserveSourceOrder.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const res = createMockRes();
    const pending = dispatch(
      createTestApp(require('../telegram')),
      retainedSourceRequest(row),
      res,
    );
    // Wait only for this request to reach its ordering dependency, not for a wall-clock timeout.
    for (let attempt = 0; !release && attempt < 50; attempt++)
      await new Promise((resolve) => setImmediate(resolve));
    const retainedBeforeRecovery = mockInputService.register.mock.calls.length;
    const savedBeforeRecovery = mockSaveInput.mock.calls.length;
    const admittedBeforeRecovery = lastAgentId;
    release({ latest_source_sequence: 12, observed_at: 1_725_000_000_000, stale: false });
    await pending;
    expect(savedBeforeRecovery).toBe(1);
    expect(retainedBeforeRecovery).toBe(1);
    expect(admittedBeforeRecovery).toBeNull();
    expect(res.body.input).toMatchObject({ sourceEventId: row.sourceEventId, retained: true });
    expect(mockInputService.register.mock.invocationCallOrder[0]).toBeLessThan(
      mockObserveSourceOrder.mock.invocationCallOrder[0],
    );
    expect(mockInputService.ready).not.toHaveBeenCalled();
    expect(mockInputService.bindStream).not.toHaveBeenCalled();
  });

  test('durable intake releases its own preparation lease when ordering fails after storage', async () => {
    const row = inputIdentity();
    mockInputService.register.mockResolvedValue(row);
    mockInputService.defer.mockResolvedValue({ ...row, leaseUntil: 0 });
    mockObserveSourceOrder.mockRejectedValue(
      new Error('Synthetic ordering dependency unavailable'),
    );
    const res = createMockRes();
    await dispatch(createTestApp(require('../telegram')), retainedSourceRequest(row), res);
    expect(res.statusCode).toBe(503);
    expect(mockSaveInput).toHaveBeenCalledTimes(1);
    expect(mockInputService.register).toHaveBeenCalledTimes(1);
    expect(res.body).toMatchObject({
      observed: false,
      error: 'source_order_unavailable',
      input: { sourceEventId: row.sourceEventId, retained: true, claimed: false, leaseUntil: 0 },
    });
    expect(mockInputService.defer).toHaveBeenCalledWith('user_1', {
      sourceEventId: row.sourceEventId,
      claimToken: row.claimToken,
    });
    expect(res.body.input.claimToken).toBeUndefined();
    expect(lastAgentId).toBeNull();
    expect(mockInputService.bindStream).not.toHaveBeenCalled();
  });

  test('durable intake preserves its unavailable receipt if releasing the owned lease fails', async () => {
    const row = inputIdentity();
    mockInputService.register.mockResolvedValue(row);
    mockInputService.defer.mockRejectedValue(new Error('Synthetic lease conflict'));
    mockObserveSourceOrder.mockRejectedValue(new Error('Synthetic ordering unavailable'));
    const res = createMockRes();
    await dispatch(createTestApp(require('../telegram')), retainedSourceRequest(row), res);
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({
      error: 'source_order_unavailable',
      input: {
        retained: true,
        claimed: true,
        claimToken: row.claimToken,
        leaseUntil: row.leaseUntil,
      },
    });
    expect(lastAgentId).toBeNull();
  });

  test('durable intake does not release a duplicate preparation claim when ordering fails', async () => {
    const row = { ...inputIdentity(), registrationId: '22222222-2222-4222-8222-222222222222' };
    mockInputService.register.mockResolvedValue(row);
    mockObserveSourceOrder.mockRejectedValue(new Error('Synthetic ordering unavailable'));
    const res = createMockRes();
    await dispatch(
      createTestApp(require('../telegram')),
      retainedSourceRequest(row, {
        preparationId: '33333333-3333-4333-8333-333333333333',
      }),
      res,
    );
    expect(res.statusCode).toBe(503);
    expect(res.body.input).toMatchObject({ claimed: false, retained: true });
    expect(mockInputService.defer).not.toHaveBeenCalled();
    expect(lastAgentId).toBeNull();
  });

  test.each([
    null,
    {},
    { preparation: null },
    { preparation: {} },
    { preparation: { version: 1, message: { message_id: 13 } } },
    { preparationId: 'invalid' },
  ])(
    'durable intake rejects incomplete preparation before ordering or storage: %j',
    async (invalid) => {
      const row = inputIdentity();
      const req = retainedSourceRequest(row, invalid || {});
      if (invalid === null || Object.keys(invalid).length === 0) req.body.input = invalid;
      const res = createMockRes();
      await dispatch(createTestApp(require('../telegram')), req, res);
      expect(res.statusCode).toBe(400);
      expect(mockSaveInput).not.toHaveBeenCalled();
      expect(mockInputService.register).not.toHaveBeenCalled();
      expect(mockObserveSourceOrder).not.toHaveBeenCalled();
      expect(lastAgentId).toBeNull();
    },
  );

  test('durable intake preserves an already saved original when a duplicate source carries edited text', async () => {
    const row = { ...inputIdentity(), registrationId: '22222222-2222-4222-8222-222222222222' };
    mockInputService.register.mockResolvedValue(row);
    require('~/db/models').Message.exists.mockResolvedValueOnce(true);
    mockObserveSourceOrder.mockResolvedValue({
      latest_source_sequence: 13,
      observed_at: 1_725_000_000_000,
      stale: true,
    });
    const res = createMockRes();
    await dispatch(
      createTestApp(require('../telegram')),
      retainedSourceRequest(row, {
        text: 'Edited duplicate text',
        preparationId: '33333333-3333-4333-8333-333333333333',
      }),
      res,
    );
    expect(mockSaveInput).not.toHaveBeenCalled();
    expect(res.body).toMatchObject({ stale: true, input: { retained: true, claimed: false } });
    expect(res.body.input.claimToken).toBeUndefined();
    expect(lastAgentId).toBeNull();
  });

  test('durable intake never claims a receipt when registration fails after message storage', async () => {
    mockInputService.register.mockRejectedValue(new Error('Synthetic registration unavailable'));
    const res = createMockRes();
    await dispatch(
      createTestApp(require('../telegram')),
      retainedSourceRequest(inputIdentity()),
      res,
    );
    expect(res.statusCode).toBe(503);
    expect(mockSaveInput).toHaveBeenCalledTimes(1);
    expect(res.body.input).toBeUndefined();
    expect(mockObserveSourceOrder).not.toHaveBeenCalled();
    expect(lastAgentId).toBeNull();
  });

  test('durable intake leaves source-only commands unretained when ordering fails', async () => {
    const req = retainedSourceRequest(inputIdentity());
    delete req.body.input;
    mockObserveSourceOrder.mockRejectedValue(
      new Error('Synthetic ordering dependency unavailable'),
    );
    const res = createMockRes();
    await dispatch(createTestApp(require('../telegram')), req, res);
    expect(res.statusCode).toBe(503);
    expect(res.body.input).toBeUndefined();
    expect(mockSaveInput).not.toHaveBeenCalled();
    expect(mockInputService.register).not.toHaveBeenCalled();
    expect(lastAgentId).toBeNull();
  });

  test('prepared ingress saves the original source before returning its owned preparation receipt without Main admission', async () => {
    const row = inputIdentity();
    mockInputService.register.mockResolvedValue(row);
    const app = createTestApp(require('../telegram')),
      res = createMockRes();
    await dispatch(
      app,
      createMockReq({
        url: '/api/viventium/telegram/source-order',
        headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
        body: {
          telegramUserId: 'tg-1',
          telegramChatId: '-100123',
          telegramMessageThreadId: '77',
          sourceSequence: 12,
          input: {
            text: 'original caption',
            conversationId: 'new',
            conversationGeneration: row.conversationGeneration,
            preparationId: row.registrationId,
            preparation: { version: 1, message: { message_id: 12 } },
          },
        },
      }),
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.input).toMatchObject({ claimed: true, claimToken: 'owned-token' });
    expect(mockSaveInput).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ text: 'original caption', messageId: 'source-message' }),
      expect.anything(),
    );
    expect(mockSaveInput.mock.invocationCallOrder[0]).toBeLessThan(
      mockInputService.register.mock.invocationCallOrder[0],
    );
    const [savedReq, savedInput] = mockSaveInput.mock.calls[0];
    const original =
      require('~/server/services/viventium/interactionContext').getTrustedInteractionContext(
        savedReq,
      );
    expect(original.source_segments).toEqual([
      expect.objectContaining({
        source_event_id: row.sourceEventId,
        source_index: 0,
        source_message_id: 'source-message',
        source_received_at: original.source_received_at,
        text: 'original caption',
      }),
    ]);
    expect(original.source_received_at).toEqual(expect.any(Number));
    expect(savedInput.metadata.viventium.originalInputReceipt).toEqual({
      sourceEventId: row.sourceEventId,
      receivedAt: original.source_received_at,
    });
    expect(mockInputService.register.mock.calls[0][2]).toBe(original.source_received_at);
    expect(mockRetainAcceptedInteractionInput).not.toHaveBeenCalled();
    expect(lastAgentId).toBeNull();
  });
  test('prepared ingress preserves an idle owned conversation and its original history parent', async () => {
    const row = inputIdentity();
    row.conversationId = 'idle-owned-conversation';
    mockInputService.register.mockImplementation(async (identity) => ({ ...row, ...identity }));
    mockGetConvo.mockResolvedValue({
      conversationId: row.conversationId,
      endpoint: 'agents',
    });
    mockGetMessages.mockResolvedValue([
      {
        messageId: 'old-worker-answer',
        parentMessageId: 'old-file-source',
        createdAt: '2026-01-01T12:00:00.000Z',
        isCreatedByUser: false,
      },
    ]);
    const res = createMockRes();
    await dispatch(
      createTestApp(require('../telegram')),
      createMockReq({
        url: '/api/viventium/telegram/source-order',
        headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
        body: {
          telegramUserId: 'tg-1',
          telegramChatId: '-100123',
          telegramMessageThreadId: '77',
          sourceSequence: 12,
          input: {
            text: 'Continue the file-backed work.',
            conversationId: row.conversationId,
            conversationGeneration: row.conversationGeneration,
            preparationId: row.registrationId,
            preparation: { version: 1, message: { message_id: 12 } },
          },
        },
      }),
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.input.conversationId).toBe(row.conversationId);
    expect(mockSaveInput).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        conversationId: row.conversationId,
        parentMessageId: 'old-worker-answer',
      }),
      expect.anything(),
    );
    expect(mockInputService.register).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: row.conversationId }),
      row.registrationId,
      expect.any(Number),
    );
    expect(lastAgentId).toBeNull();
  });

  test('rapid prepared inputs reuse their active original conversation before the first answer creates it', async () => {
    const row = inputIdentity();
    row.conversationId = 'first-pending-conversation';
    mockInputService.resolvePendingConversation.mockResolvedValue({
      conversationId: row.conversationId,
    });
    mockInputService.register.mockImplementation(async (identity) => ({ ...row, ...identity }));
    const app = createTestApp(require('../telegram')),
      res = createMockRes();
    await dispatch(
      app,
      createMockReq({
        url: '/api/viventium/telegram/source-order',
        headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
        body: {
          telegramUserId: 'tg-1',
          telegramChatId: '-100123',
          telegramMessageThreadId: '77',
          sourceSequence: 13,
          input: {
            text: 'A separate current request',
            conversationId: row.conversationId,
            conversationGeneration: row.conversationGeneration,
            preparationId: row.registrationId,
            preparation: { version: 1, message: { message_id: 13 } },
          },
        },
      }),
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(mockInputService.resolvePendingConversation).toHaveBeenCalledWith({
      requestedConversationId: row.conversationId,
      conversationGeneration: row.conversationGeneration,
      libreChatUserId: 'user_1',
      telegramUserId: 'tg-1',
      telegramChatId: '-100123',
      telegramMessageThreadId: '77',
      sourceOrderScope: row.sourceOrderScope,
      sourceSequence: 13,
    });
    expect(mockInputService.register).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: row.conversationId }),
      row.registrationId,
      expect.any(Number),
    );
    expect(mockSaveInput).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        conversationId: row.conversationId,
        text: 'A separate current request',
      }),
      expect.anything(),
    );
    expect(res.body.input.conversationId).toBe(row.conversationId);
  });
  test.each(['new', 'removed-conversation'])(
    'no pending ownership proof preserves normal reset for %s',
    async (requested) => {
      const row = inputIdentity();
      mockInputService.register.mockImplementation(async (identity) => ({ ...row, ...identity }));
      const app = createTestApp(require('../telegram')),
        res = createMockRes();
      await dispatch(
        app,
        createMockReq({
          url: '/api/viventium/telegram/source-order',
          headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
          body: {
            telegramUserId: 'tg-1',
            telegramChatId: '-100123',
            telegramMessageThreadId: '77',
            sourceSequence: 13,
            input: {
              text: 'New request',
              conversationId: requested,
              conversationGeneration: row.conversationGeneration,
              preparationId: row.registrationId,
              preparation: { version: 1, message: { message_id: 13 } },
            },
          },
        }),
        res,
      );
      expect(res.statusCode).toBe(200);
      expect(res.body.input.conversationId).toBe('11111111-1111-5111-8111-111111111111');
      if (requested === 'new')
        expect(mockInputService.resolvePendingConversation).not.toHaveBeenCalled();
    },
  );
  test('prepared ingress cannot give an overlapping handler the current preparation token', async () => {
    const row = inputIdentity();
    mockInputService.register.mockResolvedValue(row);
    const app = createTestApp(require('../telegram')),
      res = createMockRes();
    await dispatch(
      app,
      createMockReq({
        url: '/api/viventium/telegram/source-order',
        headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
        body: {
          telegramUserId: 'tg-1',
          telegramChatId: '-100123',
          telegramMessageThreadId: '77',
          sourceSequence: 12,
          input: {
            text: 'caption',
            conversationId: 'new',
            conversationGeneration: row.conversationGeneration,
            preparationId: '22222222-2222-4222-8222-222222222222',
            preparation: { version: 1, message: { message_id: 12 } },
          },
        },
      }),
      res,
    );
    expect(res.body.input).toMatchObject({ claimed: false, retained: true });
    expect(res.body.input.claimToken).toBeUndefined();
  });
  test('prepared continuation reuses owned text/files and preserves original order under a separate current presentation fence', async () => {
    const row = { ...inputIdentity(), state: 'ready' };
    mockInputService.read.mockResolvedValue(row);
    mockInputService.ready.mockResolvedValue(row);
    mockInputService.inputEnvelope.mockResolvedValue({
      ...row,
      preparation: { message: { date: 1700000000 } },
    });
    mockInputService.readPrepared.mockResolvedValue({
      text: 'Original voice goal',
      fileIds: [],
      imageUrls: [],
    });
    mockObserveSourceOrder.mockResolvedValue({
      latest_source_sequence: 13,
      observed_at: 1700000000000,
      stale: true,
    });
    mockGetConvo.mockResolvedValue({
      conversationId: row.conversationId,
      endpoint: 'agents',
      agent_id: 'agent_default',
    });
    mockGetMessages.mockResolvedValue([
      { messageId: 'later-answer', parentMessageId: 'later-correction', createdAt: new Date() },
    ]);
    // This prepared source has no persisted row yet, so it continues at the current head.
    mockInputMessageRead = jest.fn(() => ({ select: () => ({ lean: async () => null }) }));
    const app = createTestApp(require('../telegram')),
      res = createMockRes();
    await dispatch(
      app,
      createMockReq({
        url: '/api/viventium/telegram/inputs/continue',
        headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
        body: {
          telegramUserId: 'tg-1',
          inputClaim: { sourceEventId: row.sourceEventId, claimToken: row.claimToken },
        },
      }),
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(mockLastInteractionContext).toMatchObject({
      source_sequence: 12,
      source_event_id: row.sourceEventId,
      ready_input_continuation: {
        source_message_id: 'source-message',
        presentation_source_sequence: 13,
      },
    });
    expect(lastParentMessageId).toBe('later-answer');
    expect(mockLastPreparedBody.text).toBe('Original voice goal');
    expect(mockLastPreparedBody.clientTimestamp).toBe('2023-11-14T22:13:20.000Z');
    expect(mockProcessAgentFileUpload).not.toHaveBeenCalled();
    expect(mockCaptureAcceptedInteractionInput).not.toHaveBeenCalled();
    expect(mockInputService.bindStream).toHaveBeenCalledWith(
      'user_1',
      expect.objectContaining({ sourceEventId: row.sourceEventId }),
      'stream_1',
    );
    expect(res.body.inputPresentation).toMatchObject({
      sourceSequence: 12,
      presentationSourceSequence: 13,
    });
    expect(res.body.prepared.text).toBe('Original voice goal');
  });
  /* === VIVENTIUM START === Pending singleton ancestry uses existing owned history and native source fences. === */
  test.each([
    'owned base',
    'healthy original',
    'already repaired',
    'descendant head',
    'missing head',
    'foreign head',
    'foreign conversation head',
    'deleted head',
    'deleted ancestor',
    'cyclic head',
    'admitted source',
    'failed source',
    'deleted source',
    'foreign source',
    'wrong source event',
    'native fence',
    'raced source',
    'missing source parent',
  ])('prepared singleton recovery preserves the protected source carrier with %s', async (mode) => {
    const row = { ...inputIdentity(), state: 'ready' };
    const original = mode === 'healthy original' ? 'base-answer' : 'unpublished-answer';
    const baseUser = {
      user: 'user_1',
      conversationId: row.conversationId,
      messageId: 'base-user',
      parentMessageId: '',
      sender: 'User',
      isCreatedByUser: true,
      text: 'Earlier user goal.',
      createdAt: new Date(1000),
    };
    const baseAnswer = {
      user: 'user_1',
      conversationId: row.conversationId,
      messageId: 'base-answer',
      parentMessageId: 'base-user',
      sender: 'Assistant',
      isCreatedByUser: false,
      text: 'Earlier actual answer.',
      createdAt: new Date(2000),
    };
    const source = {
      user: 'user_1',
      conversationId: row.conversationId,
      messageId: row.sourceMessageId,
      parentMessageId: original,
      sender: 'User',
      isCreatedByUser: true,
      text: 'Original retained goal.',
      createdAt: new Date(3000),
      metadata: {
        viventium: {
          telegramInput: {
            state: 'ready',
            sourceEventId: row.sourceEventId,
            originalParentMessageId: original,
          },
          interactionContext: { source_event_id: row.sourceEventId },
        },
      },
    };
    const history = mode === 'missing head' ? [source] : [baseUser, baseAnswer, source];
    if (['healthy original', 'descendant head', 'already repaired'].includes(mode))
      history.push({
        user: 'user_1',
        conversationId: row.conversationId,
        messageId: 'transient-answer',
        parentMessageId: row.sourceMessageId,
        isCreatedByUser: false,
        sender: 'Assistant',
        text: 'Transient response.',
        createdAt: new Date(4000),
        // A stable descendant exercises the ancestry fence; a live draft is skipped by design.
        unfinished: mode !== 'descendant head',
      });
    if (mode === 'already repaired') source.parentMessageId = 'base-answer';
    if (mode === 'foreign head') baseAnswer.user = 'other-owner';
    if (mode === 'foreign conversation head') baseAnswer.conversationId = 'other-conversation';
    if (mode === 'deleted head') baseAnswer.deletedAt = new Date();
    if (mode === 'deleted ancestor') baseUser.deletedAt = new Date();
    if (mode === 'cyclic head') {
      baseUser.parentMessageId = 'base-answer';
      baseAnswer.parentMessageId = 'base-user';
    }
    if (mode === 'admitted source') source.metadata.viventium.telegramInput.state = 'admitted';
    if (mode === 'failed source') source.metadata.viventium.telegramInput.state = 'failed';
    if (mode === 'deleted source') source.deletedAt = new Date();
    if (mode === 'foreign source') source.user = 'other-owner';
    if (mode === 'missing source parent') delete source.parentMessageId;
    if (mode === 'wrong source event')
      source.metadata.viventium.telegramInput.sourceEventId = 'different-source';
    mockInputSourceHistory.mockImplementation(async (filter) =>
      history.filter(
        (entry) => entry.user === filter.user && entry.conversationId === filter.conversationId,
      ),
    );
    if (mode === 'native fence')
      mockMutateNativeResponseSources.mockRejectedValueOnce(
        Object.assign(new Error('Native source cannot change'), { code: 'native_source_conflict' }),
      );
    mockInputService.read.mockResolvedValue(row);
    mockInputService.ready.mockResolvedValue(row);
    mockInputService.inputEnvelope.mockResolvedValue({
      ...row,
      preparation: { message: { date: 1700000000 } },
    });
    mockInputService.readPrepared.mockResolvedValue({
      text: source.text,
      fileIds: [],
      imageUrls: [],
    });
    mockObserveSourceOrder.mockResolvedValue({
      latest_source_sequence: 13,
      observed_at: 1700000000000,
      stale: true,
    });
    mockGetConvo.mockResolvedValue({
      conversationId: row.conversationId,
      endpoint: 'agents',
      agent_id: 'agent_default',
    });
    mockGetMessages.mockResolvedValue(history);
    mockInputMessageRead = jest.fn((filter) => ({
      select: () => ({
        lean: async () => history.find((entry) => entry.messageId === filter.messageId) || null,
      }),
    }));
    mockInputMessageUpdate.mockImplementation(async (filter, update) => {
      const entry = history.find((candidate) => candidate.messageId === filter.messageId);
      if (!entry) return { matchedCount: 0 };
      if (mode === 'raced source' && update.$set?.parentMessageId) return { matchedCount: 0 };
      if (update.$set?.parentMessageId) entry.parentMessageId = update.$set.parentMessageId;
      return { matchedCount: 1 };
    });
    mockClaimedLogicalTurn = { logical_turn_id: 'singleton-turn', revision: 1 };
    let captured;
    mockAfterAdmission = async (req) => {
      const {
        captureMainContextSnapshot,
        traceMainHistoryAncestry,
      } = require('~/server/services/viventium/ViventiumMainContextService');
      const { formatMessage, formatAgentMessages } = require('@librechat/agents');
      const proof = traceMainHistoryAncestry({
        messages: history,
        headId: req.body.parentMessageId,
        ownerId: 'user_1',
        conversationId: row.conversationId,
      });
      const visible = [
        ...(proof.messageIds || []).map((id) => history.find((entry) => entry.messageId === id)),
        source,
      ];
      captured = captureMainContextSnapshot(req, {
        agent: {
          id: 'main',
          model_parameters: {
            configuration: { defaultHeaders: { 'X-GlassHive-Agent-Id': 'main' } },
          },
        },
        visibleMessages: visible,
        messages: formatAgentMessages(
          visible.map((message) => ({
            ...formatMessage({ message }),
            messageId: message.messageId,
          })),
        ).messages,
        historyAncestry: proof,
        protectUnreconciledHistory: true,
        nativeBodyCarrier: true,
      });
    };
    const res = createMockRes();
    const run = dispatch(
      createTestApp(require('../telegram')),
      createMockReq({
        url: '/api/viventium/telegram/inputs/continue',
        headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
        body: {
          telegramUserId: 'tg-1',
          inputClaim: { sourceEventId: row.sourceEventId, claimToken: row.claimToken },
        },
      }),
      res,
    );
    if (!['owned base', 'healthy original', 'already repaired'].includes(mode)) {
      await expect(run).rejects.toMatchObject(
        mode === 'native fence'
          ? { code: 'native_source_conflict' }
          : { code: 'source_context_unavailable', status: 413 },
      );
      expect(source.parentMessageId).toBe(mode === 'missing source parent' ? undefined : original);
      return;
    }
    await run;
    expect(res.statusCode).toBe(200);
    expect(lastParentMessageId).toBe('base-answer');
    expect(source.parentMessageId).toBe('base-answer');
    expect(
      captured.visibleMessageChain.filter((entry) => entry.current_input).map((entry) => entry.id),
    ).toEqual([row.sourceMessageId]);
    expect(source.text).toBe('Original retained goal.');
    if (mode === 'healthy original') expect(mockInputSourceHistory).not.toHaveBeenCalled();
    if (mode === 'already repaired') expect(mockMutateNativeResponseSources).not.toHaveBeenCalled();
  });
  /* === VIVENTIUM END === */
  test('prepared recovery does not reparent a source under its own transient response', async () => {
    const row = { ...inputIdentity(), state: 'ready' };
    mockInputService.read.mockResolvedValue(row);
    mockInputService.ready.mockResolvedValue(row);
    mockInputService.inputEnvelope.mockResolvedValue({
      ...row,
      preparation: { message: { date: 1700000000 } },
    });
    mockInputService.readPrepared.mockResolvedValue({
      text: 'Original voice goal',
      fileIds: [],
      imageUrls: [],
    });
    mockObserveSourceOrder.mockResolvedValue({
      latest_source_sequence: 13,
      observed_at: 1700000000000,
      stale: true,
    });
    mockGetConvo.mockResolvedValue({
      conversationId: row.conversationId,
      endpoint: 'agents',
      agent_id: 'agent_default',
    });
    mockGetMessages.mockResolvedValue([
      { messageId: 'original-answer', parentMessageId: '', createdAt: new Date(0) },
      {
        messageId: 'transient-response',
        parentMessageId: row.sourceMessageId,
        createdAt: new Date(),
      },
    ]);
    mockInputMessageRead = jest.fn(() => ({
      select: () => ({
        lean: async () => ({
          metadata: {
            viventium: { telegramInput: { originalParentMessageId: 'original-answer' } },
          },
        }),
      }),
    }));
    const app = createTestApp(require('../telegram')),
      res = createMockRes();
    await dispatch(
      app,
      createMockReq({
        url: '/api/viventium/telegram/inputs/continue',
        headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
        body: {
          telegramUserId: 'tg-1',
          inputClaim: { sourceEventId: row.sourceEventId, claimToken: row.claimToken },
        },
      }),
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(mockLastInteractionContext).toMatchObject({
      source_sequence: 12,
      source_event_id: row.sourceEventId,
      ready_input_continuation: {
        source_message_id: 'source-message',
        presentation_source_sequence: 13,
      },
    });
    expect(lastParentMessageId).toBe('original-answer');
    expect(mockInputMessageRead).toHaveBeenCalledWith(mockInputService.messageFilter(row));
    expect(mockLastPreparedBody.text).toBe('Original voice goal');
    expect(mockLastPreparedBody.clientTimestamp).toBe('2023-11-14T22:13:20.000Z');
    expect(mockProcessAgentFileUpload).not.toHaveBeenCalled();
    expect(mockCaptureAcceptedInteractionInput).not.toHaveBeenCalled();
    expect(mockInputService.bindStream).toHaveBeenCalledWith(
      'user_1',
      expect.objectContaining({ sourceEventId: row.sourceEventId }),
      'stream_1',
    );
    expect(res.body.inputPresentation).toMatchObject({
      sourceSequence: 12,
      presentationSourceSequence: 13,
    });
    expect(res.body.prepared.text).toBe('Original voice goal');
  });
  /* === VIVENTIUM START ===
   * Purpose: a retained input's ingress row becomes its turn's durable source authority once its
   * exact stream is admitted, so the Telegram dispatcher may present a late follow-up of the turn.
   * === VIVENTIUM END === */
  function continueRetainedInput(
    row,
    {
      preparation = { message: { date: 1700000000 } },
      body = {},
      envelope = {},
      savedFailure = false,
    } = {},
  ) {
    mockInputService.read.mockResolvedValue(row);
    mockInputService.ready.mockResolvedValue(row);
    mockInputService.inputEnvelope.mockResolvedValue({ ...row, preparation, ...envelope });
    mockInputService.readPrepared.mockResolvedValue({
      text: 'Original voice goal',
      fileIds: [],
      imageUrls: [],
    });
    mockObserveSourceOrder.mockResolvedValue({
      latest_source_sequence: 13,
      observed_at: 1700000000000,
      stale: true,
    });
    mockGetConvo.mockResolvedValue({
      conversationId: row.conversationId,
      endpoint: 'agents',
      agent_id: 'agent_default',
    });
    mockGetMessages.mockResolvedValue([]);
    mockInputMessageRead = jest.fn(() => ({ select: () => ({ lean: async () => null }) }));
    if (savedFailure) exactSavedFailure(row);
    const res = createMockRes();
    const done = dispatch(
      createTestApp(require('../telegram')),
      createMockReq({
        url: '/api/viventium/telegram/inputs/continue',
        headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
        body: {
          telegramUserId: 'tg-1',
          inputClaim: { sourceEventId: row.sourceEventId, claimToken: row.claimToken },
          ...body,
        },
      }),
      res,
    );
    return { res, done };
  }

  const retainedAuthorityBinding = (row) => [
    { sourceEventId: row.sourceEventId, libreChatUserId: 'user_1', streamId: 'stream_1' },
    [
      {
        $set: {
          authorityBoundAt: { $ifNull: ['$authorityBoundAt', '$$NOW'] },
          inputMode: { $ifNull: ['$inputMode', 'text'] },
        },
      },
    ],
  ];

  test('a retained input binds its ingress authority to exactly its admitted stream', async () => {
    const row = { ...inputIdentity(), state: 'ready' };
    const { res, done } = continueRetainedInput(row);
    await done;

    expect(res.statusCode).toBe(200);
    const calls = mockTelegramIngressUpdateOne.mock.calls;
    const index = calls.findIndex(([filter]) => filter?.streamId === 'stream_1');
    expect(calls[index]).toEqual(retainedAuthorityBinding(row));
    // The input's stream is admitted first, then its authority binds to that same stream.
    expect(mockInputService.bindStream.mock.invocationCallOrder[0]).toBeLessThan(
      mockTelegramIngressUpdateOne.mock.invocationCallOrder[index],
    );
  });

  test('first prepared input in a new conversation binds its actual onStart author after admission', async () => {
    const row = {
      ...inputIdentity(),
      libreChatUserId: 'user_1',
      state: 'ready',
      conversationId: '11111111-1111-5111-8111-111111111111',
      requestedConversationId: 'new',
    };
    const events = [];
    const stored = { inputState: 'ready', inputClaimToken: row.claimToken };
    mockClaimedLogicalTurn = { logical_turn_id: 'new-turn', revision: 1 };
    mockInputService.bindStream.mockImplementation(async (owner, claim, streamId) => {
      expect(owner).toBe(row.libreChatUserId);
      expect(claim).toEqual({ sourceEventId: row.sourceEventId, claimToken: row.claimToken });
      Object.assign(stored, { inputState: 'admitted', streamId });
      events.push('admitted');
    });
    mockTelegramIngressUpdateOne.mockImplementation(async (filter, update) => {
      if (Array.isArray(update)) {
        expect(stored.inputState).toBe('admitted');
        stored.authorityBoundAt = new Date();
        events.push('authority');
      } else if (update.$set?.responseBinding) {
        expect(stored.authorityBoundAt).toBeInstanceOf(Date);
        expect(filter).toMatchObject({
          libreChatUserId: row.libreChatUserId,
          sourceEventId: row.sourceEventId,
          sourceMessageId: row.sourceMessageId,
          conversationId: row.conversationId,
          streamId: stored.streamId,
          inputState: stored.inputState,
          inputClaimToken: stored.inputClaimToken,
        });
        stored.responseBinding = update.$set.responseBinding;
        events.push('author');
      }
      return { acknowledged: true, matchedCount: 1 };
    });
    mockAfterAdmission = async (req, context) => {
      const vm = require('vm');
      const { Constants } = require('librechat-data-provider');
      const base = fs.readFileSync(require.resolve('~/app/clients/BaseClient'), 'utf8');
      const normalizeStart = base.indexOf('  processOverideIds() {');
      const normalizeEnd = base.indexOf('  async setMessageOptions(', normalizeStart);
      const normalizer = vm.runInNewContext(`({${base.slice(normalizeStart, normalizeEnd)}})`, {
        Constants,
      });
      normalizer.options = { req };
      const [, sourceMessageId] = normalizer.processOverideIds();
      const conversationId = req.body.conversationId;
      expect(conversationId).toBe(row.conversationId);
      expect(sourceMessageId).toBe(row.sourceMessageId);
      expect(req.body.overrideUserMessageId).toBe(
        `${row.sourceMessageId}${Constants.COMMON_DIVIDER}1`,
      );
      const controller = fs.readFileSync(
        require.resolve('~/server/controllers/agents/request'),
        'utf8',
      );
      const start = controller.indexOf(
        '        const onStart = (userMsg, respMsgId, _isNewConvo) => {',
      );
      const end = controller.indexOf('        const startPartialCheckpointing = () => {', start);
      const source = {
        _id: 'synthetic-source-row',
        messageId: sourceMessageId,
        conversationId,
        text: 'First input',
      };
      const { nativeResponseSource } = jest.requireActual('@librechat/data-schemas');
      const sandbox = {
        req,
        Date,
        getTrustedInteractionContext: require('~/server/services/viventium/interactionContext')
          .getTrustedInteractionContext,
        nativeResponseSource,
        require: (name) => {
          if (name === '@librechat/api') return jest.requireActual(name);
          throw new Error(`Unexpected source reread: ${name}`);
        },
        jobCreatedAt: 1,
        streamId: 'stream_1',
        conversationId,
        userId: row.libreChatUserId,
        claimedInteractionContext: context,
        sender: 'AI',
        voiceLatencyEnabled: false,
        assistantTerminalPersistenceStarted: false,
        client: { options: { agent: {} } },
        logger: { warn: jest.fn() },
        trackAssistantSnapshot: (work) => work(),
        ensureUserSourceSegmentPersisted: async () => {
          events.push('source');
          return source;
        },
        persistAssistantSnapshot: async () => {
          events.push('placeholder');
          return { persisted: true };
        },
        GenerationJobManager: { updateMetadata: async () => {}, emitChunk: async () => {} },
      };
      vm.runInNewContext(
        `let userMessage,responseMessageId,generationStartedAt,placeholderSnapshotSaved,lastAssistantSnapshotFingerprint;${controller.slice(start, end)};globalThis.start=onStart;`,
        sandbox,
      );
      await sandbox.start(
        { messageId: sourceMessageId, conversationId, text: 'First input' },
        'new-assistant',
        true,
      );
      expect(req._viventiumHostResponseIdentity).toMatchObject({
        userId: row.libreChatUserId,
        conversationId,
        responseMessageId: 'new-assistant',
        streamId: 'stream_1',
        jobCreatedAt: 1,
        logicalTurnId: 'new-turn',
        revision: 1,
        source: nativeResponseSource(source),
      });
    };
    const { res, done } = continueRetainedInput(row);
    await done;
    expect(res.statusCode).toBe(200);
    expect(stored.responseBinding).toEqual({
      streamId: 'stream_1',
      responseMessageId: 'new-assistant',
      logicalTurnId: 'new-turn',
      revision: 1,
    });
    expect(events).toEqual(['admitted', 'authority', 'source', 'author', 'placeholder']);
  });

  test('a retained input whose ingress row is not its source on that stream fails closed', async () => {
    mockTelegramIngressUpdateOne.mockResolvedValue({
      acknowledged: true,
      matchedCount: 0,
      modifiedCount: 0,
    });
    const row = { ...inputIdentity(), state: 'ready' };
    const { res, done } = continueRetainedInput(row);

    await expect(done).rejects.toMatchObject({ code: 'TELEGRAM_INGRESS_AUTHORITY_UNAVAILABLE' });
    expect(mockTelegramIngressUpdateOne).toHaveBeenCalledWith(...retainedAuthorityBinding(row));
    // No started receipt is sent for a turn whose durable authority is unavailable.
    expect(res.body?.streamId).toBeUndefined();
  });
  /* === VIVENTIUM START ===
   * Purpose: a Telegram reply reaches Main as typed evidence that Core resolved against this owner's
   * and chat's durable delivery receipts. A retained input's quote comes from its own durable
   * ingress preparation, so a request can neither substitute nor add one.
   * === VIVENTIUM END === */
  const repliedPreparation = (replied) => ({
    message: {
      message_id: 12,
      date: 1700000000,
      text: 'Does it still fit?',
      from: { id: 'tg-1', is_bot: false, first_name: 'Owner' },
      ...(replied ? { reply_to_message: replied } : {}),
    },
  });
  const deliveredAnswer = {
    message_id: 14382,
    date: 1700000000,
    text: 'Willow fits 450 with 8 left.',
    from: { id: 5550001, is_bot: true, first_name: 'Viventium' },
    chat: { id: -100123, type: 'supergroup' },
  };
  const deliveredReceipt = (filter) => ({
    lean: async () =>
      filter?.telegramSentMessageIds === '14382'
        ? {
            userId: 'user_1',
            conversationId: 'canonical-conversation',
            logicalMessageId: 'main-answer',
            sourceKind: 'assistant_message',
            telegramSentMessageIds: ['14382'],
            status: 'sent',
          }
        : null,
  });

  test('a retained reply to a delivered answer reaches Main as its verified quote', async () => {
    mockReplyReceiptFindOne.mockImplementation(deliveredReceipt);
    const row = { ...inputIdentity(), state: 'ready' };
    const { res, done } = continueRetainedInput(row, {
      preparation: repliedPreparation(deliveredAnswer),
      body: {
        replyContextV1: {
          version: 1,
          repliedTelegramMessageId: '777',
          quoteText: 'A different quote',
          senderKind: 'owner_candidate',
        },
      },
    });
    await done;

    expect(res.statusCode).toBe(200);
    expect(mockReplyReceiptFindOne).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user_1',
        telegramChatId: '-100123',
        telegramSentMessageIds: '14382',
        status: 'sent',
      }),
    );
    expect(mockLastInteractionContext.reply_context).toEqual({
      version: 1,
      provenanceStatus: 'verified',
      senderRole: 'assistant_self',
      repliedTelegramMessageId: '14382',
      quoteText: 'Willow fits 450 with 8 left.',
      logicalMessageId: 'main-answer',
      conversationId: 'canonical-conversation',
      sourceKind: 'assistant_message',
    });
  });

  test('a retained reply to the owner’s own message stays the owner’s, whatever the adapter claims', async () => {
    const row = { ...inputIdentity(), state: 'ready' };
    const { res, done } = continueRetainedInput(row, {
      preparation: repliedPreparation({
        message_id: 14380,
        date: 1700000000,
        text: '108 booklets, $450 budget.',
        from: { id: 'tg-1', is_bot: false, first_name: 'Owner' },
      }),
      body: {
        replyContextV1: {
          version: 1,
          repliedTelegramMessageId: '14380',
          quoteText: '108 booklets, $450 budget.',
          senderKind: 'assistant_candidate',
        },
      },
    });
    await done;

    expect(res.statusCode).toBe(200);
    expect(mockLastInteractionContext.reply_context).toEqual({
      version: 1,
      provenanceStatus: 'platform_verified',
      senderRole: 'owner_self',
      repliedTelegramMessageId: '14380',
      quoteText: '108 booklets, $450 budget.',
    });
  });

  test('a retained input that replies to nothing carries no quote, whatever the request adds', async () => {
    mockReplyReceiptFindOne.mockImplementation(deliveredReceipt);
    const row = { ...inputIdentity(), state: 'ready' };
    const { res, done } = continueRetainedInput(row, {
      preparation: repliedPreparation(null),
      body: {
        replyContextV1: { version: 1, repliedTelegramMessageId: '14382', quoteText: 'Added' },
      },
    });
    await done;

    expect(res.statusCode).toBe(200);
    expect(mockLastInteractionContext.reply_context).toBeUndefined();
    expect(mockReplyReceiptFindOne).not.toHaveBeenCalled();
  });

  test('an identity-only continuation keeps its ready record’s quoted document text, for that file only', async () => {
    const row = { ...inputIdentity(), state: 'ready' };
    // The actual bot continuation sends only the input identity, never a reply descriptor.
    const { res, done } = continueRetainedInput(row, {
      preparation: repliedPreparation({
        message_id: 14390,
        date: 1700000000,
        caption: 'Rate card',
        from: { id: 5550001, is_bot: true, first_name: 'Viventium' },
        document: { file_id: 'doc-1', file_name: 'rates.pdf' },
      }),
      envelope: {
        quotedAttachmentTexts: [
          { fileId: 'doc-1', extractedText: 'Willow 4.10 per booklet' },
          { fileId: 'doc-other', extractedText: 'Unrelated text' },
        ],
      },
    });
    await done;

    expect(res.statusCode).toBe(200);
    expect(mockLastInteractionContext.reply_context).toMatchObject({
      provenanceStatus: 'unverified',
      senderRole: 'unknown',
      repliedTelegramMessageId: '14390',
      quoteText: 'Rate card',
      attachments: [
        {
          kind: 'document',
          fileId: 'doc-1',
          filename: 'rates.pdf',
          extractedText: 'Willow 4.10 per booklet',
        },
      ],
    });
  });

  test('the passage the user selected in Telegram is the admitted quote', async () => {
    mockReplyReceiptFindOne.mockImplementation(deliveredReceipt);
    const row = { ...inputIdentity(), state: 'ready' };
    const preparation = repliedPreparation(deliveredAnswer);
    preparation.message.quote = { text: '8 left', position: 22, is_manual: true };
    const { res, done } = continueRetainedInput(row, { preparation });
    await done;

    expect(res.statusCode).toBe(200);
    expect(mockLastInteractionContext.reply_context).toMatchObject({
      provenanceStatus: 'verified',
      repliedTelegramMessageId: '14382',
      logicalMessageId: 'main-answer',
      quoteText: '8 left',
    });
  });

  test('an unavailable receipt lookup keeps the quote only as unverified evidence', async () => {
    mockReplyReceiptFindOne.mockImplementation(() => {
      throw new Error('receipts unavailable');
    });
    const row = { ...inputIdentity(), state: 'ready' };
    const { res, done } = continueRetainedInput(row, {
      preparation: repliedPreparation(deliveredAnswer),
    });
    await done;

    expect(res.statusCode).toBe(200);
    expect(mockLastInteractionContext.reply_context).toEqual({
      version: 1,
      provenanceStatus: 'unverified',
      senderRole: 'unknown',
      repliedTelegramMessageId: '14382',
      quoteText: 'Willow fits 450 with 8 left.',
    });
  });

  test('POST /chat resolves a fresh Telegram reply against this owner’s delivered receipts', async () => {
    mockReplyReceiptFindOne.mockImplementation(deliveredReceipt);
    mockInputMessageRead = jest.fn(() => ({ select: () => ({ lean: async () => null }) }));
    const req = createMockReq({
      url: '/api/viventium/telegram/chat',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      body: {
        text: 'Does it still fit?',
        conversationId: 'new',
        telegramUserId: 'tg-1',
        telegramChatId: '-100123',
        telegramMessageId: '42',
        sourceOrderScope: trustedTelegramSourceScope(),
        sourceEventId: trustedTelegramSourceEventId(),
        replyContextV1: {
          version: 1,
          repliedTelegramMessageId: '14382',
          quoteText: 'Willow fits 450 with 8 left.',
          senderKind: 'assistant_candidate',
        },
      },
    });
    const res = createMockRes();

    await dispatch(createTestApp(require('../telegram')), req, res);

    expect(res.statusCode).toBe(200);
    expect(mockLastInteractionContext.reply_context).toMatchObject({
      provenanceStatus: 'verified',
      senderRole: 'assistant_self',
      repliedTelegramMessageId: '14382',
      logicalMessageId: 'main-answer',
    });
  });
  /* === VIVENTIUM END === */

  /* === VIVENTIUM START === A recovered source keeps its own parent after later answers. === */
  test('prepared recovery keeps a persisted source under its original parent after a later answer', async () => {
    const row = { ...inputIdentity(), state: 'ready' };
    mockInputService.read.mockResolvedValue(row);
    mockInputService.ready.mockResolvedValue(row);
    mockInputService.inputEnvelope.mockResolvedValue({
      ...row,
      preparation: { message: { date: 1700000000 } },
    });
    mockInputService.readPrepared.mockResolvedValue({
      text: 'Original voice goal',
      fileIds: [],
      imageUrls: [],
    });
    mockObserveSourceOrder.mockResolvedValue({
      latest_source_sequence: 13,
      observed_at: 1700000000000,
      stale: true,
    });
    mockGetConvo.mockResolvedValue({
      conversationId: row.conversationId,
      endpoint: 'agents',
      agent_id: 'agent_default',
    });
    // A later source's answer is the head; re-anchoring under it would make this source its own
    // ancestor once that later source already descends from it.
    mockGetMessages.mockResolvedValue([
      { messageId: 'original-answer', parentMessageId: '', createdAt: new Date(0) },
      { messageId: 'later-answer', parentMessageId: 'later-source', createdAt: new Date() },
    ]);
    mockInputMessageRead = jest.fn(() => ({
      select: () => ({
        lean: async () => ({
          metadata: {
            viventium: { telegramInput: { originalParentMessageId: 'original-answer' } },
          },
        }),
      }),
    }));
    const app = createTestApp(require('../telegram')),
      res = createMockRes();
    await dispatch(
      app,
      createMockReq({
        url: '/api/viventium/telegram/inputs/continue',
        headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
        body: {
          telegramUserId: 'tg-1',
          inputClaim: { sourceEventId: row.sourceEventId, claimToken: row.claimToken },
        },
      }),
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(lastParentMessageId).toBe('original-answer');
    expect(mockInputMessageRead).toHaveBeenCalledWith(mockInputService.messageFilter(row));
  });
  /* === VIVENTIUM END === */
  test('admitted input recovery returns the same existing stream without preparing or invoking Main again', async () => {
    const row = { ...inputIdentity(), state: 'admitted', streamId: 'retained-stream' };
    mockInputService.read.mockResolvedValue(row);
    mockInputService.inputEnvelope.mockResolvedValue(row);
    mockInputService.readPrepared.mockResolvedValue({ text: 'goal', fileIds: [], imageUrls: [] });
    mockGetJob.mockResolvedValue({
      metadata: {
        userId: 'user_1',
        conversationId: row.conversationId,
        interactionContext: {
          logical_turn_id: 'turn',
          revision: 1,
          ready_input_continuation: { presentation_source_sequence: 13 },
        },
      },
    });
    const app = createTestApp(require('../telegram')),
      res = createMockRes();
    await dispatch(
      app,
      createMockReq({
        url: '/api/viventium/telegram/inputs/continue',
        headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
        body: {
          telegramUserId: 'tg-1',
          inputClaim: { sourceEventId: row.sourceEventId, claimToken: row.claimToken },
        },
      }),
      res,
    );
    expect(res.body).toMatchObject({
      streamId: 'retained-stream',
      duplicate: true,
      logical_turn_id: 'turn',
    });
    expect(lastAgentId).toBeNull();
    expect(mockInputService.ready).not.toHaveBeenCalled();
  });

  test('admitted input whose generator died before dispatch continues on its own stream', async () => {
    const row = { ...inputIdentity(), state: 'admitted', streamId: 'retained-stream' };
    mockInputService.read.mockResolvedValue(row);
    mockInputService.inputEnvelope.mockResolvedValue(row);
    mockInputService.readPrepared.mockResolvedValue({ text: 'goal', fileIds: [], imageUrls: [] });
    mockGetJob.mockResolvedValue({
      metadata: {
        userId: 'user_1',
        conversationId: row.conversationId,
        interactionContext: { logical_turn_id: 'turn', revision: 2 },
      },
    });
    const orphan = {
      status: 'running',
      nativeDispatchOwner: 'dead-generator',
      nativeDispatchLeaseUntil: Date.now() - 1,
    };
    const continueInput = async () => {
      const app = createTestApp(require('../telegram')),
        res = createMockRes();
      await dispatch(
        app,
        createMockReq({
          url: '/api/viventium/telegram/inputs/continue',
          headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
          body: {
            telegramUserId: 'tg-1',
            inputClaim: { sourceEventId: row.sourceEventId, claimToken: row.claimToken },
          },
        }),
        res,
      );
      return res;
    };

    // A live lease or an already-dispatched revision stays the existing duplicate.
    for (const persisted of [
      { ...orphan, nativeDispatchLeaseUntil: Date.now() + 60_000 },
      { ...orphan, nativeResponse: { invocationId: 'dispatched' } },
      { ...orphan, nativeDispatchOwner: undefined },
    ]) {
      mockGetPersistedJob.mockResolvedValueOnce(persisted);
      const res = await continueInput();
      expect(res.body).toMatchObject({ streamId: 'retained-stream', duplicate: true });
      expect(lastAgentId).toBeNull();
    }

    mockGetPersistedJob.mockResolvedValueOnce(orphan);
    await continueInput();
    expect(mockGetPersistedJob).toHaveBeenLastCalledWith('retained-stream');
    expect(lastStreamId).toBe('retained-stream');
    expect(mockInputService.ready).not.toHaveBeenCalled();
    expect(mockLastPreparedBody.text).toBe('goal');
    expect(mockLastInteractionContext).toMatchObject({ source_event_id: row.sourceEventId });
  });

  test('POST /source-order records the authenticated Telegram source before chat admission', async () => {
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);
    const req = createMockReq({
      url: '/api/viventium/telegram/source-order',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      body: {
        telegramUserId: 'tg-1',
        telegramChatId: '-100123',
        telegramMessageThreadId: '77',
        sourceSequence: 12347,
        ownerId: 'forged-owner',
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(mockObserveSourceOrder).toHaveBeenCalledWith({
      source_order_scope: expect.stringMatching(/^[a-f0-9]{64}$/),
      source_sequence: 12347,
    });
    expect(res.body).toEqual({
      observed: true,
      sourceOrderScope: expect.stringMatching(/^[a-f0-9]{64}$/),
      sourceEventId: expect.stringMatching(/^[a-f0-9]{64}$/),
      latestSourceSequence: 12347,
      observedAt: 1_725_000_000_000,
      stale: false,
      durability: 'durable',
      replicaSafe: true,
    });
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
    expect(mockTelegramIngressUpdateOne).toHaveBeenCalledWith(
      {
        _id: 'ingress_1',
        dedupeKey: 'm:-100123:42',
        telegramUserId: 'tg-1',
        telegramChatId: '-100123',
        telegramMessageId: '42',
        authorityBoundAt: null,
      },
      {
        $set: expect.objectContaining({
          libreChatUserId: 'user_1',
          conversationId: expect.any(String),
          streamId: lastStreamId,
          telegramMessageThreadId: '',
          sourceSequence: 42,
          sourceOrderScope: trustedTelegramSourceScope(),
          sourceEventId: trustedTelegramSourceEventId(),
          authorityBoundAt: expect.any(Date),
        }),
      },
    );
    const boundConversationId = mockTelegramIngressUpdateOne.mock.calls[0][1].$set.conversationId;
    expect(boundConversationId).not.toBe('new');
    expect(boundConversationId).toBe(res.body.conversationId);
    expect(boundConversationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  test('POST /chat fails closed before authoring when durable ingress authority cannot bind', async () => {
    mockTelegramIngressUpdateOne.mockResolvedValueOnce({
      acknowledged: true,
      matchedCount: 0,
      modifiedCount: 0,
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

    expect(res.statusCode).toBe(503);
    expect(res.body.code).toBe('TELEGRAM_INGRESS_AUTHORITY_UNAVAILABLE');
    expect(lastAgentId).toBeNull();
  });

  test('POST keeps Main available without Parallel tools while orchestration is not ready', async () => {
    mockGetUserById.mockResolvedValueOnce({
      _id: 'user_1',
      role: 'USER',
      personalization: { orchestration_mode: 'parallel' },
    });
    mockAuthoringOrchestrationReadiness.mockResolvedValueOnce({
      requested: true,
      available: false,
      status: 'unready',
      reason: 'parallel_clean_room_proxy_unhealthy',
    });
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);
    const req = createMockReq({
      url: '/api/viventium/telegram/chat',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      body: {
        text: 'Start durable background work',
        conversationId: 'new',
        telegramUserId: 'tg-1',
        telegramChatId: '-100123',
        telegramMessageId: '42',
        sourceOrderScope: trustedTelegramSourceScope(),
        sourceEventId: trustedTelegramSourceEventId(),
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(req._viventiumParallelWorkTurnAvailable).toBe(false);
    expect(mockAuthoringOrchestrationReadiness).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: 'user_1',
        consumer: 'telegram',
      }),
    );
    expect(mockTelegramIngressCreate).toHaveBeenCalledTimes(1);
    expect(lastStreamId).not.toBeNull();
  });

  test('POST reuses operational owner authority without a release verifier subprocess', async () => {
    mockGetUserById.mockResolvedValueOnce({
      _id: 'user_1',
      role: 'USER',
      personalization: { orchestration_mode: 'parallel' },
    });
    const childProcess = require('child_process');
    const subprocess = jest.spyOn(childProcess, 'execFileSync');
    try {
      const telegramRouter = require('../telegram');
      const app = createTestApp(telegramRouter);
      const req = createMockReq({
        url: '/api/viventium/telegram/chat',
        headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
        body: {
          text: 'Give one direct synthetic reply',
          conversationId: 'new',
          telegramUserId: 'tg-1',
          telegramChatId: '-100123',
          telegramMessageId: '42',
          sourceOrderScope: trustedTelegramSourceScope(),
          sourceEventId: trustedTelegramSourceEventId(),
        },
      });
      const res = createMockRes();
      const eventLoopTicks = [Date.now()];
      const eventLoopProbe = setInterval(() => eventLoopTicks.push(Date.now()), 25);

      try {
        await dispatch(app, req, res);
      } finally {
        clearInterval(eventLoopProbe);
        eventLoopTicks.push(Date.now());
      }

      expect(res.statusCode).toBe(200);
      expect(req._viventiumParallelWorkTurnClaim).toEqual(
        expect.objectContaining({ available: true }),
      );
      expect(
        subprocess.mock.calls.filter(
          ([, args]) => Array.isArray(args) && args.includes('--validate-snapshot'),
        ),
      ).toHaveLength(0);
      expect(
        Math.max(
          ...eventLoopTicks.slice(1).map((timestamp, index) => timestamp - eventLoopTicks[index]),
        ),
      ).toBeLessThan(1_000);
    } finally {
      subprocess.mockRestore();
    }
  });

  test.each(['open', 'missing'])(
    'POST admits operational owner Parallel work when the release gate is %s',
    async (releaseState) => {
      mockGetUserById.mockResolvedValueOnce({
        _id: 'user_1',
        role: 'USER',
        personalization: { orchestration_mode: 'parallel' },
      });
      if (releaseState === 'open') {
        const gate = openGate('REL-UC-004');
        const gates = validGates().map((item) => (item.case_id === gate.case_id ? gate : item));
        writeReleaseSnapshot({
          label: 'NOT READY',
          release_ready: false,
          exposure_allowed: false,
          gate_count: gates.length,
          open_gate_count: 1,
          gates,
          open_gates: [gate],
        });
      } else {
        fs.unlinkSync(releasePath);
      }
      const telegramRouter = require('../telegram');
      const app = createTestApp(telegramRouter);
      const req = createMockReq({
        url: '/api/viventium/telegram/chat',
        headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
        body: {
          text: 'Start durable background work',
          conversationId: 'new',
          telegramUserId: 'tg-1',
          telegramChatId: '-100123',
          telegramMessageId: '42',
          sourceOrderScope: trustedTelegramSourceScope(),
          sourceEventId: trustedTelegramSourceEventId(),
        },
      });
      const res = createMockRes();

      await dispatch(app, req, res);

      expect(res.statusCode).toBe(200);
      expect(req._viventiumParallelWorkTurnAvailable).toBe(true);
      expect(req._viventiumParallelWorkTurnClaim).toEqual(
        expect.objectContaining({ available: true }),
      );
      expect(mockAuthoringOrchestrationReadiness).toHaveBeenCalledWith(
        expect.objectContaining({ ownerId: 'user_1', consumer: 'telegram' }),
      );
      expect(mockTelegramIngressCreate).toHaveBeenCalledTimes(1);
      expect(lastStreamId).not.toBeNull();
    },
  );

  test('POST /chat keeps Main available without Parallel tools when source ordering is not durable', async () => {
    mockGetUserById.mockResolvedValueOnce({
      _id: 'user_1',
      role: 'USER',
      personalization: { orchestration_mode: 'parallel' },
    });
    mockGetSourceOrderCapabilities.mockReturnValueOnce({
      durability: 'process',
      replica_safe: false,
    });
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);
    const req = createMockReq({
      url: '/api/viventium/telegram/chat',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      body: {
        text: 'Start durable background work',
        conversationId: 'new',
        telegramUserId: 'tg-1',
        telegramChatId: '-100123',
        telegramMessageId: '42',
        sourceOrderScope: trustedTelegramSourceScope(),
        sourceEventId: trustedTelegramSourceEventId(),
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(req._viventiumParallelWorkTurnAvailable).toBe(false);
    expect(mockAuthoringOrchestrationReadiness).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'user_1', consumer: 'telegram' }),
    );
    expect(mockTelegramIngressCreate).toHaveBeenCalledTimes(1);
    expect(lastStreamId).not.toBeNull();
  });

  test.each([
    ['Telegram user', { telegramUserId: '' }],
    ['chat', { telegramChatId: '' }],
    ['source scope', { sourceOrderScope: '' }],
    ['source event', { sourceEventId: '' }],
    ['structural source scope', { sourceOrderScope: 'not-a-hash' }],
    ['structural source event', { sourceEventId: 'not-a-hash' }],
    ['trusted source scope', { sourceOrderScope: 'a'.repeat(64) }],
    ['trusted source event', { sourceEventId: 'a'.repeat(64) }],
    ['positive source sequence', { telegramMessageId: '0' }],
    ['positive source sequence', { telegramMessageId: '-1' }],
  ])('POST /chat rejects Parallel turns without valid %s identity', async (_label, override) => {
    mockGetUserById.mockResolvedValueOnce({
      _id: 'user_1',
      role: 'USER',
      personalization: { orchestration_mode: 'parallel' },
    });
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);
    const req = createMockReq({
      url: '/api/viventium/telegram/chat',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      body: {
        text: 'Start durable background work',
        conversationId: 'new',
        telegramUserId: 'tg-1',
        telegramChatId: '-100123',
        telegramMessageId: '42',
        sourceOrderScope: trustedTelegramSourceScope(),
        sourceEventId: trustedTelegramSourceEventId(),
        ...override,
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual(
      _label === 'Telegram user'
        ? { error: 'telegramUserId is required' }
        : {
            error: 'Telegram chat requires verified source ordering.',
            code: 'INVALID_SOURCE_ORDER_IDENTITY',
            retryable: true,
          },
    );
    expect(mockAuthoringOrchestrationReadiness).not.toHaveBeenCalled();
    expect(mockTelegramIngressCreate).not.toHaveBeenCalled();
  });

  test('POST /chat rejects focused Telegram authoring without source-order identity', async () => {
    mockGetUserById.mockResolvedValueOnce({
      _id: 'user_1',
      role: 'USER',
      personalization: { orchestration_mode: 'focused' },
    });
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);
    const req = createMockReq({
      url: '/api/viventium/telegram/chat',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      body: { text: 'Answer directly', conversationId: 'new', telegramUserId: 'tg-1' },
      withTrustedSourceIdentity: false,
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(400);
    expect(mockTelegramIngressCreate).not.toHaveBeenCalled();
  });

  test('POST /chat keeps focused response_only authoring valid with trusted source identity', async () => {
    mockGetUserById.mockResolvedValueOnce({
      _id: 'user_1',
      role: 'USER',
      personalization: { orchestration_mode: 'focused' },
    });
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);
    const req = createMockReq({
      url: '/api/viventium/telegram/chat',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      body: {
        text: 'Answer directly',
        conversationId: 'new',
        telegramUserId: 'tg-1',
        telegramChatId: '-100123',
        telegramMessageId: '42',
        sourceOrderScope: trustedTelegramSourceScope(),
        sourceEventId: trustedTelegramSourceEventId(),
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(mockLastAdapterCapabilities).toEqual(
      expect.objectContaining({ supersede_scope: 'response_only' }),
    );
  });

  test('POST keeps working in focused mode when Parallel Work is disabled for the deployment', async () => {
    process.env.VIVENTIUM_PARALLEL_WORK_AVAILABLE = 'false';
    mockGetUserById.mockResolvedValueOnce({
      _id: 'user_1',
      role: 'USER',
      personalization: { orchestration_mode: 'parallel' },
    });
    mockAuthoringOrchestrationReadiness.mockResolvedValueOnce({
      requested: false,
      available: false,
      status: 'disabled',
      reason: '',
    });
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);
    const req = createMockReq({
      url: '/api/viventium/telegram/chat',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      body: {
        text: 'Answer this ordinary focused turn',
        conversationId: 'new',
        telegramUserId: 'tg-1',
        telegramMessageId: '43',
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.streamId).toBe('stream_1');
    expect(lastAgentId).toBe('agent_default');
    expect(typeof lastStreamId).toBe('string');
    expect(lastStreamId.startsWith('telegram-')).toBe(true);
    expect(mockTelegramIngressUpdateOne).toHaveBeenCalledWith(
      {
        _id: 'ingress_1',
        dedupeKey: 'm:-100123:43',
        telegramUserId: 'tg-1',
        telegramChatId: '-100123',
        telegramMessageId: '43',
        authorityBoundAt: null,
      },
      {
        $set: expect.objectContaining({
          libreChatUserId: 'user_1',
          conversationId: expect.any(String),
          streamId: lastStreamId,
          telegramMessageThreadId: '',
          sourceSequence: 43,
          sourceOrderScope: trustedTelegramSourceScope(),
          sourceEventId: trustedTelegramSourceEventId({ sourceSequence: 43 }),
          authorityBoundAt: expect.any(Date),
        }),
      },
    );
    const boundConversationId = mockTelegramIngressUpdateOne.mock.calls[0][1].$set.conversationId;
    expect(boundConversationId).not.toBe('new');
    expect(boundConversationId).toBe(res.body.conversationId);
    expect(boundConversationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  test('POST authors Telegram context, ignores forged authority, and returns claimed turn metadata', async () => {
    mockClaimedLogicalTurn = { logical_turn_id: 'logical-telegram-1', revision: 3 };
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);
    const req = createMockReq({
      url: '/api/viventium/telegram/chat',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      body: {
        text: 'hi',
        conversationId: 'new',
        telegramUserId: 'tg-1',
        telegramChatId: '-100123',
        telegramMessageId: '12347',
        telegramMessageThreadId: '77',
        interactionContext: {
          actor_kind: 'system',
          origin: 'scheduler',
          surface: 'workbench',
          source_event_id: 'forged-event',
          source_received_at: 1,
        },
        adapterCapabilities: { segment_stability: 'provisional', supersede_scope: 'response_only' },
      },
    });
    const res = createMockRes();

    const beforeDispatch = Date.now();
    await dispatch(app, req, res);
    const afterDispatch = Date.now();

    expect(mockLastInteractionContext).toEqual({
      actor_kind: 'external_user',
      origin: 'interactive',
      surface: 'telegram',
      conversation_id: expect.any(String),
      revision: 1,
      source_event_id: trustedTelegramSourceEventId({
        sourceOrderScope: trustedTelegramSourceScope({ telegramMessageThreadId: '77' }),
        sourceSequence: 12347,
      }),
      source_order_scope: expect.stringMatching(/^[a-f0-9]{64}$/),
      source_sequence: 12347,
      source_received_at: expect.any(Number),
    });
    expect(Number.isSafeInteger(mockLastInteractionContext.source_received_at)).toBe(true);
    expect(mockLastInteractionContext.source_received_at).toBeGreaterThanOrEqual(beforeDispatch);
    expect(mockLastInteractionContext.source_received_at).toBeLessThanOrEqual(afterDispatch);
    expect(mockLastAdapterCapabilities).toEqual({
      segment_stability: 'immediate',
      /* === VIVENTIUM START === Additive Telegram turn authoring. */
      supersede_scope: 'response_only',
      /* === VIVENTIUM END === */
    });
    expect(mockLastDeliveryPolicy).toEqual({ commit_authority: 'external_adapter' });
    expect(req.body).not.toHaveProperty('interactionContext');
    expect(req.body).not.toHaveProperty('adapterCapabilities');
    expect(res.body).toMatchObject({
      logical_turn_id: 'logical-telegram-1',
      revision: 3,
      metadata: {
        viventium: {
          interactionContext: expect.objectContaining({
            surface: 'telegram',
            logical_turn_id: 'logical-telegram-1',
            revision: 3,
          }),
        },
      },
    });
  });

  test.each(['a'.repeat(64), 'invalid-generation'])(
    'POST validates and carries the source conversation generation: %s',
    async (generation) => {
      const app = createTestApp(require('../telegram'));
      const res = createMockRes();
      await dispatch(
        app,
        createMockReq({
          url: '/api/viventium/telegram/chat',
          headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
          body: {
            telegramUserId: 'tg-1',
            telegramChatId: '-100123',
            telegramMessageId: '12347',
            text: 'Original first-use goal',
            conversationId: 'new',
            conversationGeneration: generation,
          },
        }),
        res,
      );
      if (generation === 'invalid-generation') {
        expect(res.statusCode).toBe(400);
        expect(mockCaptureAcceptedInteractionInput).not.toHaveBeenCalled();
      } else {
        expect(res.statusCode).toBe(200);
        expect(mockLastInteractionContext.source_conversation_generation).toMatch(/^[a-f0-9]{64}$/);
      }
    },
  );

  test('POST carries the same authenticated source order observed before provider work', async () => {
    mockGetConvo.mockResolvedValue({
      conversationId: 'existing-conversation',
      endpoint: 'agents',
      agent_id: 'agent_default',
    });
    mockGetMessages.mockResolvedValue([{ messageId: 'previous-response', createdAt: new Date() }]);
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);
    const identity = {
      telegramUserId: 'tg-1',
      telegramChatId: '-100123',
      telegramMessageThreadId: '77',
    };
    const observed = createMockRes();
    await dispatch(
      app,
      createMockReq({
        url: '/api/viventium/telegram/source-order',
        headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
        body: { ...identity, sourceSequence: 12347 },
      }),
      observed,
    );
    const res = createMockRes();
    await dispatch(
      app,
      createMockReq({
        url: '/api/viventium/telegram/chat',
        headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
        body: {
          ...identity,
          text: 'Keep this second instruction.',
          conversationId: 'existing-conversation',
          telegramMessageId: '12347',
          sourceOrderScope: observed.body.sourceOrderScope,
          sourceEventId: observed.body.sourceEventId,
        },
      }),
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(mockCaptureAcceptedInteractionInput).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        conversationId: expect.any(String),
        streamId: expect.stringMatching(/^telegram-/),
        text: 'Keep this second instruction.',
        parentMessageId: 'previous-response',
      }),
    );
    expect(mockCaptureAcceptedInteractionInput.mock.invocationCallOrder[0]).toBeLessThan(
      mockGetConvo.mock.invocationCallOrder[1],
    );
    expect(mockLastInteractionContext).toMatchObject({
      source_order_scope: observed.body.sourceOrderScope,
      source_sequence: 12347,
      source_event_id: observed.body.sourceEventId,
    });
  });

  test.each(['retain', 'capture'])(
    'POST preserves typed source capacity from %s through the existing error owner',
    async (stage) => {
      const body = {
        code: 'source_input_capacity',
        retryable: true,
        error: 'Input capacity is full.',
      };
      const error = Object.assign(new Error(body.error), {
        code: body.code,
        statusCode: 503,
        body,
      });
      (stage === 'retain'
        ? mockRetainAcceptedInteractionInput
        : mockCaptureAcceptedInteractionInput
      ).mockRejectedValueOnce(error);
      const app = createTestApp(require('../telegram'));
      app.use(require('@librechat/api').ErrorController);
      const res = createMockRes();
      res.send = res.json;
      await dispatch(
        app,
        createMockReq({
          url: '/api/viventium/telegram/chat',
          headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
          body: { telegramUserId: 'tg-1', text: 'Keep the next goal.', conversationId: 'new' },
        }),
        res,
      );
      expect(res.statusCode).toBe(503);
      expect(res.body).toEqual(body);
      expect(lastStreamId).toBeNull();
    },
  );

  test('POST uses the accepted canonical conversation after resolved source capture', async () => {
    mockCaptureAcceptedInteractionInput.mockResolvedValue({ conversation_id: 'canonical-new' });
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);
    const res = createMockRes();
    await dispatch(
      app,
      createMockReq({
        url: '/api/viventium/telegram/chat',
        headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
        body: {
          telegramUserId: 'tg-1',
          text: 'An ordinary new conversation.',
          conversationId: 'new',
        },
      }),
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.conversationId).toBe('canonical-new');
    expect(lastParentMessageId).toBe('00000000-0000-0000-0000-000000000000');
  });

  test('POST retains trusted input before ingress and parent lookups can reorder it', async () => {
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);
    const res = createMockRes();
    await dispatch(
      app,
      createMockReq({
        url: '/api/viventium/telegram/chat',
        headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
        body: {
          telegramUserId: 'tg-1',
          telegramChatId: '-100123',
          telegramMessageId: '12347',
          text: 'Preserve the whole goal before setup.',
          conversationId: 'existing-conversation',
        },
      }),
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(mockRetainAcceptedInteractionInput).toHaveBeenCalledWith(expect.any(Object), {
      conversationId: 'existing-conversation',
      text: 'Preserve the whole goal before setup.',
    });
    const retainedAt = mockRetainAcceptedInteractionInput.mock.invocationCallOrder[0];
    expect(retainedAt).toBeLessThan(mockTelegramIngressCreate.mock.invocationCallOrder[0]);
    expect(retainedAt).toBeLessThan(mockGetConvo.mock.invocationCallOrder[0]);
    expect(retainedAt).toBeLessThan(
      mockCaptureAcceptedInteractionInput.mock.invocationCallOrder[0],
    );
  });

  test.each(['scope', 'event', 'sequence', 'thread'])(
    'POST rejects mismatched declared source %s',
    async (field) => {
      const telegramRouter = require('../telegram');
      const app = createTestApp(telegramRouter);
      const body = {
        telegramUserId: 'tg-1',
        telegramChatId: '-100123',
        telegramMessageId: '12347',
        text: 'An ordinary request.',
        conversationId: 'new',
      };
      if (field === 'scope') body.sourceOrderScope = 'f'.repeat(64);
      if (field === 'event') body.sourceEventId = 'e'.repeat(64);
      if (field === 'sequence') body.sourceSequence = 12348;
      if (field === 'thread') body.telegramMessageThreadId = 'invalid';
      const res = createMockRes();
      await dispatch(
        app,
        createMockReq({
          url: '/api/viventium/telegram/chat',
          headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
          body,
        }),
        res,
      );
      expect(res.statusCode).toBe(400);
      if (field === 'sequence') {
        expect(res.body).toMatchObject({ error: 'invalid_source_order' });
      } else {
        expect(res.body).toMatchObject({ code: 'INVALID_SOURCE_ORDER_IDENTITY' });
      }
      expect(mockLastInteractionContext).toBeNull();
    },
  );

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

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(422);
    expect(res.body).toEqual(
      expect.objectContaining({
        attachmentProcessingError: true,
        error: expect.stringMatching(/Telegram attachment upload failed for "archive\.zip"/),
      }),
    );
  });

  /* === VIVENTIUM START === Rapid inputs of one conversation join one turn in source order. === */
  const postRetainedInput = async (row, text, extraBody = {}) => {
    mockInputMessageRead = jest.fn(() => ({ select: () => ({ lean: async () => null }) }));
    const app = createTestApp(require('../telegram')),
      res = createMockRes();
    await dispatch(
      app,
      createMockReq({
        url: '/api/viventium/telegram/chat',
        headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
        body: {
          text,
          conversationId: row.requestedConversationId,
          conversationGeneration: row.conversationGeneration,
          telegramUserId: row.telegramUserId,
          telegramChatId: row.telegramChatId,
          telegramMessageId: String(row.sourceSequence),
          telegramMessageThreadId: row.telegramMessageThreadId,
          inputClaim: { sourceEventId: row.sourceEventId, claimToken: row.claimToken },
          ...extraBody,
        },
      }),
      res,
    );
    return res;
  };
  test('outage recovery prepares independently and authors every source despite reverse due order', async () => {
    const { createTelegramInputService, telegramInputDeliveryCoverage } =
      jest.requireActual('@librechat/api');
    const {
      buildTelegramSourceEventId,
    } = require('~/server/services/viventium/interactionContext');
    const { manager } = await turnOwner();
    let clock = 1_000_000,
      version = 0;
    const rows = new Map(),
      updated = new Map(),
      prepared = new Map();
    const base = inputIdentity();
    const originals = [12, 13, 14].map((sourceSequence) => ({
      sourceOrderScope: base.sourceOrderScope,
      conversationId: base.conversationId,
      requestedConversationId: base.requestedConversationId,
      conversationGeneration: base.conversationGeneration,
      telegramUserId: base.telegramUserId,
      telegramChatId: base.telegramChatId,
      telegramMessageThreadId: base.telegramMessageThreadId,
      libreChatUserId: 'user_1',
      sourceSequence,
      sourceMessageId: `source-${sourceSequence}`,
      mediaGroupId: '',
      sourceEventId: buildTelegramSourceEventId({
        source_order_scope: base.sourceOrderScope,
        source_sequence: sourceSequence,
      }),
    }));
    const store = (row) => {
      rows.set(row.sourceEventId, structuredClone(row));
      updated.set(row.sourceEventId, ++version);
      return structuredClone(row);
    };
    const service = createTelegramInputService({
      now: () => clock,
      transaction: async (operation) => operation(),
      verifyOwner: async () => true,
      verifyStream: async () => true,
      persistPrepared: async (row, value) => prepared.set(row.sourceEventId, value),
      readPrepared: async (row) => prepared.get(row.sourceEventId) || null,
      hasCommittedDelivery: async () => false,
      readStream: async () => 'missing',
      repository: {
        read: async (value) => structuredClone(rows.get(value.sourceEventId) || null),
        insert: async (row) => store(row),
        replace: async (previous, next) => {
          store(next);
          return true;
        },
        group: async () => [],
        due: async (now, limit) =>
          [...rows.values()]
            .filter(
              (row) =>
                row.leaseUntil <= now &&
                row.retryAt <= now &&
                ['preparing', 'ready', 'admitted'].includes(row.state),
            )
            .sort(
              (left, right) => updated.get(left.sourceEventId) - updated.get(right.sourceEventId),
            )
            .slice(0, limit)
            .map((row) => structuredClone(row)),
      },
    });
    try {
      for (const row of [...originals].reverse()) await service.register(row, base.registrationId);
      clock += 120_001;
      await manager.observeSourceOrder({
        source_order_scope: base.sourceOrderScope,
        source_sequence: 14,
      });
      for (const name of ['read', 'ready', 'defer', 'bindStream']) {
        mockInputService[name].mockImplementation((...args) => service[name](...args));
      }
      mockInputService.readPrepared.mockImplementation(
        (row) => prepared.get(row.sourceEventId) || null,
      );
      mockInputService.inputEnvelope.mockImplementation(async (row) => ({
        ...row,
        preparation: {
          message: {
            message_id: row.sourceSequence,
            date: 1700000000,
            text: `Goal ${row.sourceSequence}`,
            from: { id: 'tg-1' },
          },
        },
      }));
      mockInputService.hasEarlierPreparingInput.mockImplementation(async (row) =>
        [...rows.values()].some(
          (sibling) => sibling.sourceSequence < row.sourceSequence && sibling.state === 'preparing',
        ),
      );
      mockInputService.hasNewerUnresolvedInput.mockImplementation(async (row) =>
        [...rows.values()].some(
          (sibling) =>
            sibling.sourceSequence > row.sourceSequence &&
            ['preparing', 'ready', 'admitted'].includes(sibling.state),
        ),
      );
      mockObserveSourceOrder.mockImplementation((value) => manager.observeSourceOrder(value));
      mockRetainLogicalTurnInput.mockImplementation((...args) =>
        manager.retainLogicalTurnInput(...args),
      );
      mockGetConvo.mockResolvedValue({
        conversationId: base.conversationId,
        endpoint: 'agents',
        agent_id: 'agent_default',
      });
      const claimedSequences = [];
      for (const sequence of [14, 13, 12]) {
        const [claim] = await service.claimPending(1);
        claimedSequences.push(claim?.sourceSequence);
        expect(claim.sourceSequence).toBe(sequence);
        const response = await postRetainedInput(claim, `Goal ${sequence}`);
        expect(response.statusCode).toBe(202);
        expect(response.body).toMatchObject({ code: 'source_input_pending', pending: true });
        expect(rows.get(claim.sourceEventId)).toMatchObject({ state: 'ready', leaseUntil: 0 });
        expect(lastAgentId).toBeNull();
      }
      clock += 5_001;
      const [continuation] = await service.claimPending(1);
      expect(continuation.sourceSequence).toBe(14);
      const app = createTestApp(require('../telegram')),
        response = createMockRes();
      await dispatch(
        app,
        createMockReq({
          url: '/api/viventium/telegram/inputs/continue',
          headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
          body: {
            telegramUserId: 'tg-1',
            inputClaim: {
              sourceEventId: continuation.sourceEventId,
              claimToken: continuation.claimToken,
            },
          },
        }),
        response,
      );
      expect(response.statusCode).toBe(200);
      expect(lastAgentId).toBe('agent_default');
      expect(mockLastAdapterCapabilities.supersede_scope).toBe('response_only');
      await manager.createJob(
        'outage-recovery-stream',
        'user_1',
        mockLastInteractionContext.conversation_id,
        {
          interactionContext: mockLastInteractionContext,
          adapterCapabilities: mockLastAdapterCapabilities,
          deliveryPolicy: mockLastDeliveryPolicy,
        },
      );
      const authored = await manager.commitLogicalTurnAuthor('outage-recovery-stream', 'user_1');
      expect(authored.source_segments.map((source) => source.source_sequence)).toEqual([
        12, 13, 14,
      ]);
      const coverage = telegramInputDeliveryCoverage({
        status: 'recorded',
        acknowledgement: {
          state: 'committed',
          logical_turn_id: authored.logical_turn_id,
          revision: authored.revision,
        },
        presentation: {
          userId: 'user_1',
          responseMessageId: 'combined-answer',
          conversationId: authored.conversation_id,
          interactionContext: authored,
        },
      });
      expect(coverage.sources.map((source) => source.source_event_id)).toEqual(
        originals.map((row) => row.sourceEventId),
      );
      expect(coverage.sources.map((source) => source.source_message_id)).toEqual(
        originals.map((row) => row.sourceMessageId),
      );
      expect(mockInputService.status).not.toHaveBeenCalled();
    } finally {
      await manager.destroy();
    }
  });

  test('a ready continuation defers again while an earlier source remains unprepared', async () => {
    const row = inputIdentity();
    mockInputService.hasEarlierPreparingInput.mockResolvedValue(true);
    const response = await recoverStaleInput(row);
    expect(response.statusCode).toBe(202);
    expect(response.body).toMatchObject({ code: 'source_input_pending', pending: true });
    expect(mockInputService.defer).toHaveBeenCalledTimes(1);
    expect(lastAgentId).toBeNull();
  });

  test('durable intake recovery still requires ordering authority before Main admission', async () => {
    const row = inputIdentity();
    mockInputService.read.mockResolvedValue(row);
    mockInputService.ready.mockResolvedValue({ ...row, state: 'ready' });
    const failure = new Error('Synthetic ordering dependency unavailable');
    mockObserveSourceOrder.mockRejectedValue(failure);
    await expect(postRetainedInput(row, 'Original retained request')).rejects.toBe(failure);
    expect(mockInputService.ready).toHaveBeenCalledTimes(1);
    expect(mockObserveSourceOrder).toHaveBeenCalledTimes(1);
    expect(mockInputService.bindStream).not.toHaveBeenCalled();
    expect(lastAgentId).toBeNull();
  });

  test('a fresh input retains and prepares independently before deferring to earlier preparation', async () => {
    const row = inputIdentity();
    mockInputService.read.mockResolvedValue(row);
    mockInputService.ready.mockResolvedValue({ ...row, state: 'ready' });
    mockInputService.hasEarlierPreparingInput.mockResolvedValue(true);
    const response = await postRetainedInput(row, 'Correction: use 80 booklets.');
    expect(response.statusCode).toBe(202);
    expect(response.body).toMatchObject({ code: 'source_input_pending', pending: true });
    expect(mockInputService.hasEarlierPreparingInput).toHaveBeenCalledTimes(1);
    expect(mockRetainLogicalTurnInput).toHaveBeenCalledWith(
      'user_1',
      expect.objectContaining({
        source_segments: expect.arrayContaining([
          expect.objectContaining({ source_message_id: row.sourceMessageId }),
        ]),
      }),
    );
    expect(mockRetainLogicalTurnInput.mock.invocationCallOrder[0]).toBeLessThan(
      mockInputService.ready.mock.invocationCallOrder[0],
    );
    expect(lastAgentId).toBeNull();
  });
  /* === VIVENTIUM START ===
   * Purpose: a first admission keeps its quoted document's extracted text in the ready record for
   * an identity-only continuation, and a deferred quoted input takes its own quote into the turn a
   * newer unquoted input will combine.
   * === VIVENTIUM END === */
  const documentReplyPreparation = () => ({
    message: {
      message_id: 12,
      date: 1700000000,
      text: 'Is this still right?',
      from: { id: 'tg-1', is_bot: false },
      reply_to_message: {
        message_id: 14390,
        date: 1700000000,
        caption: 'Rate card',
        from: { id: 5550001, is_bot: true },
        document: { file_id: 'doc-1', file_name: 'rates.pdf' },
      },
    },
  });
  test('a first admission keeps its quoted document text in the ready record', async () => {
    const row = inputIdentity();
    mockInputService.read.mockResolvedValue(row);
    mockInputService.ready.mockResolvedValue({ ...row, state: 'ready' });
    mockInputService.inputEnvelope.mockResolvedValue({
      ...row,
      preparation: documentReplyPreparation(),
    });
    await postRetainedInput(row, 'Is this still right?', {
      replyContextV1: {
        version: 1,
        repliedTelegramMessageId: '14390',
        quoteText: 'Rate card',
        senderKind: 'assistant_candidate',
        attachments: [
          { kind: 'document', fileId: 'doc-1', extractedText: 'Willow 4.10 per booklet' },
          { kind: 'document', fileId: 'doc-other', extractedText: 'Unrelated text' },
        ],
      },
    });
    expect(mockInputService.ready).toHaveBeenCalledWith(
      'user_1',
      expect.objectContaining({ sourceEventId: row.sourceEventId }),
      expect.objectContaining({
        quotedAttachmentTexts: [{ fileId: 'doc-1', extractedText: 'Willow 4.10 per booklet' }],
      }),
      [],
    );
  });
  test('a deferred quoted input takes its own quote into the turn it will join', async () => {
    mockReplyReceiptFindOne.mockImplementation(deliveredReceipt);
    const row = inputIdentity();
    mockInputService.read.mockResolvedValue(row);
    mockInputService.ready.mockResolvedValue({ ...row, state: 'ready' });
    mockInputService.hasNewerUnresolvedInput.mockResolvedValue(true);
    mockInputService.inputEnvelope.mockResolvedValue({
      ...row,
      preparation: {
        message: {
          message_id: 12,
          date: 1700000000,
          text: 'Does it still fit?',
          from: { id: 'tg-1', is_bot: false },
          reply_to_message: {
            message_id: 14382,
            date: 1700000000,
            text: 'Willow fits 450 with 8 left.',
            from: { id: 5550001, is_bot: true },
          },
        },
      },
    });
    mockObserveSourceOrder.mockResolvedValue({
      latest_source_sequence: row.sourceSequence + 1,
      observed_at: 1_725_000_000_000,
      stale: true,
    });
    const res = await postRetainedInput(row, 'Does it still fit?');

    expect(res.statusCode).toBe(202);
    const retained = mockRetainLogicalTurnInput.mock.calls[0][1];
    expect(retained.source_segments[0]).toMatchObject({
      source_event_id: row.sourceEventId,
      reply_context: {
        provenanceStatus: 'verified',
        repliedTelegramMessageId: '14382',
        quoteText: 'Willow fits 450 with 8 left.',
        logicalMessageId: 'main-answer',
      },
    });
  });
  const turnOwner = async () => {
    const { GenerationJobManagerClass, InMemoryEventTransport, InMemoryJobStore } =
      jest.requireActual('@librechat/api');
    const jobStore = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const manager = new GenerationJobManagerClass({
      jobStore,
      eventTransport: new InMemoryEventTransport(),
      cleanupOnComplete: false,
    });
    await manager.initialize();
    return { manager, jobStore };
  };
  test('a deferred quoted input reaches Main with its quote when an unquoted successor claims the turn', async () => {
    const {
      bindLogicalTurnContext,
      buildTelegramSourceEventId,
      getTrustedAdapterCapabilities,
      getTrustedInteractionContext,
      setTrustedInteractionContext,
    } = require('~/server/services/viventium/interactionContext');
    mockReplyReceiptFindOne.mockImplementation(deliveredReceipt);
    const quoted = inputIdentity();
    const successor = {
      ...inputIdentity(),
      sourceSequence: 13,
      sourceEventId: buildTelegramSourceEventId({
        source_order_scope: quoted.sourceOrderScope,
        source_sequence: 13,
      }),
      sourceMessageId: 'source-message-successor',
    };
    const telegramMessage = (row, text, extra = {}) => ({
      message: {
        message_id: row.sourceSequence,
        date: 1700000000,
        text,
        from: { id: 'tg-1', is_bot: false },
        ...extra,
      },
    });
    const admit = async (row, text, preparation, newer) => {
      mockInputService.read.mockResolvedValue(row);
      mockInputService.ready.mockResolvedValue({ ...row, state: 'ready' });
      mockInputService.hasNewerUnresolvedInput.mockResolvedValue(newer);
      mockInputService.inputEnvelope.mockResolvedValue({ ...row, preparation });
      mockObserveSourceOrder.mockResolvedValue({
        latest_source_sequence: successor.sourceSequence,
        observed_at: 1_725_000_000_000,
        stale: newer,
      });
      return postRetainedInput(row, text);
    };

    // The route defers the quoted input to its newer unanswered successor.
    const quotedText = 'Copy only the two totals from this quoted answer.';
    const deferredRes = await admit(
      quoted,
      quotedText,
      telegramMessage(quoted, quotedText, {
        reply_to_message: {
          message_id: 14382,
          date: 1700000000,
          text: 'Willow fits 450 with 8 left.',
          from: { id: 5550001, is_bot: true },
        },
      }),
      true,
    );
    expect(deferredRes.statusCode).toBe(202);
    expect(lastAgentId).toBeNull();
    const deferred = mockRetainLogicalTurnInput.mock.calls[0][1];

    // The route admits the unquoted successor to Main with its own adapter capabilities.
    const successorText = 'Also subtract the smaller from the larger, using that quoted answer.';
    await admit(successor, successorText, telegramMessage(successor, successorText), false);
    expect(lastAgentId).not.toBeNull();
    const admitted = mockLastInteractionContext;
    const capabilities = mockLastAdapterCapabilities;
    expect(capabilities).toMatchObject({ supersede_scope: 'response_only' });
    expect(admitted.reply_context).toBeUndefined();

    // The turn owner claims, admits and commits the successor's turn with the deferred input
    // still pending; at its generation handoff Main commits authorship and binds that context,
    // the way request.js does.
    const { manager, jobStore } = await turnOwner();
    await jobStore.retainLogicalTurnInput('user_1', deferred);
    await manager.createJob('successor-stream', 'user_1', admitted.conversation_id, {
      interactionContext: admitted,
      adapterCapabilities: capabilities,
      deliveryPolicy: mockLastDeliveryPolicy,
    });
    const authored = await manager.commitLogicalTurnAuthor('successor-stream', 'user_1');
    const req = {};
    setTrustedInteractionContext(req, admitted, capabilities);
    expect(bindLogicalTurnContext(req, authored)).toMatchObject({
      source_event_id: successor.sourceEventId,
      revision: authored.revision,
    });

    // Main's turn context carries the deferred input's quote under its source label.
    const {
      buildTurnReplyContextCapsules,
    } = require('~/server/services/viventium/ViventiumTurnReplyContext');
    const {
      buildSourceSelectionCapsule,
    } = require('~/server/services/viventium/ViventiumSourceSelectionContext');
    const replyCapsules = buildTurnReplyContextCapsules(
      getTrustedInteractionContext(req),
      getTrustedAdapterCapabilities(req),
    );
    const quotes = replyCapsules
      .split('\n')
      .filter((line) => line.includes('"replied_telegram_message_id"'))
      .map((line) => JSON.parse(line));
    expect(quotes).toEqual([
      expect.objectContaining({
        source_label: 'S1',
        replied_telegram_message_id: '14382',
        logical_message_id: 'main-answer',
        quote_text: 'Willow fits 450 with 8 left.',
      }),
    ]);
    const selection = buildSourceSelectionCapsule(req);
    const encoded = selection.split('\n').find((line) => /^[A-Za-z0-9_-]+$/.test(line));
    expect(
      JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')).sources.map(
        (source) => source.label,
      ),
    ).toEqual(['S1', 'S2']);
    expect(selection).not.toContain('owns only the current accepted input');
    await manager.destroy();
  });
  test('an older quoted input that loses its admission race reaches the winning Main with its quote', async () => {
    const {
      bindLogicalTurnContext,
      buildTelegramSourceEventId,
      getTrustedAdapterCapabilities,
      getTrustedInteractionContext,
      setTrustedInteractionContext,
    } = require('~/server/services/viventium/interactionContext');
    mockReplyReceiptFindOne.mockImplementation(deliveredReceipt);
    const older = inputIdentity();
    const newer = {
      ...inputIdentity(),
      sourceSequence: 13,
      sourceEventId: buildTelegramSourceEventId({
        source_order_scope: older.sourceOrderScope,
        source_sequence: 13,
      }),
      sourceMessageId: 'source-message-newer',
    };
    const admitToMain = async (row, text, extra = {}) => {
      mockInputService.read.mockResolvedValue(row);
      mockInputService.ready.mockResolvedValue({ ...row, state: 'ready' });
      mockInputService.hasNewerUnresolvedInput.mockResolvedValue(false);
      mockInputService.inputEnvelope.mockResolvedValue({
        ...row,
        preparation: {
          message: {
            message_id: row.sourceSequence,
            date: 1700000000,
            text,
            from: { id: 'tg-1', is_bot: false },
            ...extra,
          },
        },
      });
      mockObserveSourceOrder.mockResolvedValue({
        latest_source_sequence: row.sourceSequence,
        observed_at: 1_725_000_000_000,
        stale: false,
      });
      lastAgentId = null;
      await postRetainedInput(row, text);
      expect(lastAgentId).not.toBeNull();
      return { context: mockLastInteractionContext, capabilities: mockLastAdapterCapabilities };
    };

    // The route admits both inputs to Main; the older one carries the quote.
    const quotedText = 'Copy only the two totals from this quoted answer.';
    const olderAdmission = await admitToMain(older, quotedText, {
      reply_to_message: {
        message_id: 14382,
        date: 1700000000,
        text: 'Willow fits 450 with 8 left.',
        from: { id: 5550001, is_bot: true },
      },
    });
    const newerAdmission = await admitToMain(
      newer,
      'Also subtract the smaller from the larger, using that quoted answer.',
    );
    expect(newerAdmission.capabilities).toMatchObject({ supersede_scope: 'response_only' });

    // The older reservation is still admitting when the newer admission commits.
    const { manager, jobStore } = await turnOwner();
    const createJob = jobStore.createJob.bind(jobStore);
    let releaseOlder;
    const olderReleased = new Promise((resolve) => {
      releaseOlder = resolve;
    });
    let markOlderReserved;
    const olderReserved = new Promise((resolve) => {
      markOlderReserved = resolve;
    });
    jest.spyOn(jobStore, 'createJob').mockImplementationOnce(async (...args) => {
      markOlderReserved();
      await olderReleased;
      return createJob(...args);
    });
    const admit = async (streamId, { context, capabilities }) => {
      await manager.createJob(streamId, 'user_1', context.conversation_id, {
        interactionContext: context,
        adapterCapabilities: capabilities,
        deliveryPolicy: mockLastDeliveryPolicy,
      });
      return manager.commitLogicalTurnAuthor(streamId, 'user_1');
    };
    await manager.observeSourceOrder({
      source_order_scope: older.sourceOrderScope,
      source_sequence: older.sourceSequence,
    });
    const olderJob = admit('older-stream', olderAdmission);
    await olderReserved;
    await manager.observeSourceOrder({
      source_order_scope: older.sourceOrderScope,
      source_sequence: newer.sourceSequence,
    });
    const authored = await admit('newer-stream', newerAdmission);
    releaseOlder();
    await expect(olderJob).rejects.toMatchObject({ code: 'source_order_superseded' });

    // The winning Main owns the older input and receives its quote under its source label.
    const req = {};
    setTrustedInteractionContext(req, newerAdmission.context, newerAdmission.capabilities);
    bindLogicalTurnContext(req, authored);
    const {
      buildTurnReplyContextCapsules,
    } = require('~/server/services/viventium/ViventiumTurnReplyContext');
    const {
      buildSourceSelectionCapsule,
    } = require('~/server/services/viventium/ViventiumSourceSelectionContext');
    const quotes = buildTurnReplyContextCapsules(
      getTrustedInteractionContext(req),
      getTrustedAdapterCapabilities(req),
    )
      .split('\n')
      .filter((line) => line.includes('"replied_telegram_message_id"'))
      .map((line) => JSON.parse(line));
    expect(quotes).toEqual([
      expect.objectContaining({
        source_label: 'S1',
        replied_telegram_message_id: '14382',
        quote_text: 'Willow fits 450 with 8 left.',
      }),
    ]);
    const selection = buildSourceSelectionCapsule(req);
    const encoded = selection.split('\n').find((line) => /^[A-Za-z0-9_-]+$/.test(line));
    expect(
      JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')).sources.map(
        (source) => source.label,
      ),
    ).toEqual(['S1', 'S2']);
    await manager.destroy();
  });
  /* === VIVENTIUM END === */
  test('a stale earlier input joins the turn and defers to its newer unanswered source', async () => {
    const row = inputIdentity();
    mockInputService.read.mockResolvedValue(row);
    mockInputService.ready.mockResolvedValue({ ...row, state: 'ready' });
    mockInputService.hasNewerUnresolvedInput.mockResolvedValue(true);
    mockObserveSourceOrder.mockResolvedValue({
      latest_source_sequence: row.sourceSequence + 1,
      observed_at: 1_725_000_000_000,
      stale: true,
    });
    const res = await postRetainedInput(row, 'Compare the original quotes.');
    expect(mockRetainLogicalTurnInput).toHaveBeenCalledTimes(1);
    expect(mockInputService.hasNewerUnresolvedInput).toHaveBeenCalledWith(
      expect.objectContaining({ sourceEventId: row.sourceEventId }),
    );
    expect(res.statusCode).toBe(202);
    expect(res.body).toMatchObject({ code: 'source_input_pending', pending: true });
    expect(mockInputService.defer).toHaveBeenCalledWith('user_1', {
      sourceEventId: row.sourceEventId,
      claimToken: row.claimToken,
    });
    expect(lastAgentId).toBeNull();
  });
  const recoverStaleInput = async (row, source = null, sourceHistory = null) => {
    mockInputService.read.mockResolvedValue({ ...row, state: 'ready' });
    mockInputService.ready.mockResolvedValue({ ...row, state: 'ready' });
    mockInputService.inputEnvelope.mockResolvedValue({
      ...row,
      preparation: { message: { date: 1700000000 } },
    });
    mockInputService.readPrepared.mockResolvedValue({
      text: 'Compare the original quotes.',
      fileIds: [],
      imageUrls: [],
    });
    mockObserveSourceOrder.mockResolvedValue({
      latest_source_sequence: row.sourceSequence + 1,
      observed_at: 1_725_000_000_000,
      stale: true,
    });
    mockGetConvo.mockResolvedValue({
      conversationId: row.conversationId,
      endpoint: 'agents',
      agent_id: 'agent_default',
    });
    mockGetMessages.mockResolvedValue(
      source
        ? sourceHistory || [
            { messageId: 'original-answer', parentMessageId: '', createdAt: new Date(0) },
          ]
        : [],
    );
    mockInputMessageRead = jest.fn(() => ({ select: () => ({ lean: async () => source }) }));
    const app = createTestApp(require('../telegram')),
      res = createMockRes();
    await dispatch(
      app,
      createMockReq({
        url: '/api/viventium/telegram/inputs/continue',
        headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
        body: {
          telegramUserId: 'tg-1',
          inputClaim: { sourceEventId: row.sourceEventId, claimToken: row.claimToken },
        },
      }),
      res,
    );
    return res;
  };
  test('an earlier input a newer completed answer did not cover records a typed failure, not a standalone answer', async () => {
    const row = inputIdentity();
    mockInputService.hasNewerCompletedInput.mockResolvedValue(true);
    mockInputService.hasCommittedDelivery.mockResolvedValue(false);
    const res = await recoverStaleInput(row);
    expect(res.statusCode).toBe(202);
    expect(res.body).toMatchObject({ code: 'source_order_superseded', superseded: true });
    expect(mockInputService.status).toHaveBeenCalledWith(
      'user_1',
      { sourceEventId: row.sourceEventId, claimToken: row.claimToken },
      'failed',
      'source_input_uncovered',
      false,
    );
    expect(mockInputService.defer).not.toHaveBeenCalled();
    expect(lastAgentId).toBeNull();
  });
  test('an earlier input whose newer carrier was admitted and then failed records a typed failure, not a standalone answer', async () => {
    const row = inputIdentity();
    mockInputService.hasNewerFailedAdmittedInput.mockResolvedValue(true);
    const res = await recoverStaleInput(row);
    expect(res.statusCode).toBe(202);
    expect(res.body).toMatchObject({ code: 'source_order_superseded', superseded: true });
    expect(mockInputService.status).toHaveBeenCalledWith(
      'user_1',
      { sourceEventId: row.sourceEventId, claimToken: row.claimToken },
      'failed',
      'source_input_uncovered',
      false,
    );
    expect(mockInputService.defer).not.toHaveBeenCalled();
    expect(lastAgentId).toBeNull();
  });
  test('a recovered input whose source parent is unchanged never edits its native-fenced source', async () => {
    const row = inputIdentity();
    const source = {
      parentMessageId: 'original-answer',
      metadata: { viventium: { telegramInput: { originalParentMessageId: 'original-answer' } } },
    };
    await recoverStaleInput(row, source);
    // A live native answer of a newer input descends from this source; a no-op re-anchor through
    // the native source fence would revoke it.
    expect(mockMutateNativeResponseSources).not.toHaveBeenCalled();
    expect(lastParentMessageId).toBe('original-answer');
    await recoverStaleInput(row, { ...source, parentMessageId: 'another-parent' }, [
      { messageId: 'another-parent', parentMessageId: '', createdAt: new Date(0) },
    ]);
    expect(mockMutateNativeResponseSources).not.toHaveBeenCalled();
    expect(lastParentMessageId).toBe('another-parent');
    // A legacy self-parent is not valid persisted ancestry; use its verified original anchor.
    await recoverStaleInput(row, { ...source, parentMessageId: row.sourceMessageId });
    expect(mockMutateNativeResponseSources).toHaveBeenCalledTimes(1);
    expect(lastParentMessageId).toBe('original-answer');
  });
  test('an earlier input whose committed coverage names it settles through that coverage', async () => {
    const row = inputIdentity();
    mockInputService.hasNewerCompletedInput.mockResolvedValue(true);
    mockInputService.hasCommittedDelivery.mockResolvedValue(true);
    const res = await recoverStaleInput(row);
    expect(res.statusCode).toBe(202);
    expect(res.body).toMatchObject({ code: 'source_input_pending', pending: true });
    expect(mockInputService.defer).toHaveBeenCalledTimes(1);
    expect(mockInputService.status).not.toHaveBeenCalled();
    expect(lastAgentId).toBeNull();
  });
  /* === VIVENTIUM END === */

  test.each([false, true])(
    'retained attachment rejection settles only a typed permanent failure (%s)',
    async (permanent) => {
      const row = inputIdentity();
      mockInputService.read.mockResolvedValue(row);
      const error = Object.assign(
        new Error('Attachment preparation failed'),
        permanent ? { code: 'unsupported_file_type', status: 415, retryable: false } : {},
      );
      mockProcessAgentFileUpload.mockRejectedValueOnce(error);
      const app = createTestApp(require('../telegram')),
        res = createMockRes();
      await dispatch(
        app,
        createMockReq({
          url: '/api/viventium/telegram/chat',
          headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
          body: {
            text: 'Review the attachment',
            conversationId: row.requestedConversationId,
            conversationGeneration: row.conversationGeneration,
            telegramUserId: row.telegramUserId,
            telegramChatId: row.telegramChatId,
            telegramMessageId: String(row.sourceSequence),
            telegramMessageThreadId: row.telegramMessageThreadId,
            inputClaim: { sourceEventId: row.sourceEventId, claimToken: row.claimToken },
            files: [
              {
                filename: 'attachment.bin',
                mime_type: 'application/octet-stream',
                data: Buffer.from('synthetic bytes').toString('base64'),
              },
            ],
          },
        }),
        res,
      );
      expect(res.statusCode).toBe(permanent ? 415 : 422);
      if (permanent) {
        expect(mockInputService.status).toHaveBeenCalledTimes(1);
        expect(mockInputService.status).toHaveBeenCalledWith(
          'user_1',
          { sourceEventId: row.sourceEventId, claimToken: row.claimToken },
          'failed',
          'unsupported_file_type',
          false,
          [],
        );
        expect(res.body).toMatchObject({ code: 'unsupported_file_type', retryable: false });
      } else expect(mockInputService.status).not.toHaveBeenCalled();
      expect(mockInputService.ready).not.toHaveBeenCalled();
      expect(lastAgentId).toBeNull();
    },
  );

  test('permanent grouped upload failure passes every exact source claim to one lifecycle settlement', async () => {
    const row = inputIdentity();
    const inputClaims = [
      { sourceEventId: 'b'.repeat(64), claimToken: '22222222-2222-4222-8222-222222222222' },
      { sourceEventId: row.sourceEventId, claimToken: row.claimToken },
    ];
    mockInputService.read.mockResolvedValue(row);
    mockProcessAgentFileUpload.mockRejectedValueOnce(
      Object.assign(new Error('Unsupported group member'), {
        code: 'unsupported_file_type',
        status: 415,
        retryable: false,
      }),
    );
    const app = createTestApp(require('../telegram'));
    const res = createMockRes();
    await dispatch(
      app,
      createMockReq({
        url: '/api/viventium/telegram/chat',
        headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
        body: {
          text: 'Review this upload group',
          conversationId: row.requestedConversationId,
          conversationGeneration: row.conversationGeneration,
          telegramUserId: row.telegramUserId,
          telegramChatId: row.telegramChatId,
          telegramMessageId: String(row.sourceSequence),
          telegramMessageThreadId: row.telegramMessageThreadId,
          inputClaim: { sourceEventId: row.sourceEventId, claimToken: row.claimToken },
          inputClaims,
          files: [
            {
              filename: 'attachment.bin',
              mime_type: 'application/octet-stream',
              data: Buffer.from('synthetic bytes').toString('base64'),
            },
          ],
        },
      }),
      res,
    );
    expect(res.statusCode).toBe(415);
    expect(mockInputService.status).toHaveBeenCalledTimes(1);
    expect(mockInputService.status).toHaveBeenCalledWith(
      'user_1',
      { sourceEventId: row.sourceEventId, claimToken: row.claimToken },
      'failed',
      'unsupported_file_type',
      false,
      inputClaims,
    );
    expect(mockInputService.ready).not.toHaveBeenCalled();
    expect(lastAgentId).toBeNull();
  });

  test.each(['source_input_group_failed', 'source_input_group_conflict'])(
    'retained group ready rejection has one non-retryable attachment result (%s)',
    async (code) => {
      const row = { ...inputIdentity(), mediaGroupId: 'synthetic-group' };
      mockInputService.read.mockResolvedValue(row);
      mockInputService.ready.mockRejectedValueOnce(
        Object.assign(new Error('The saved input changed; retry from its current state.'), {
          code,
          statusCode: 409,
          body: { code, retryable: true },
        }),
      );

      const res = await postRetainedInput(row, 'Review this upload group.');

      expect(res.statusCode).toBe(409);
      expect(res.body).toEqual({
        attachmentProcessingError: true,
        code,
        retryable: false,
        error: 'This attachment group was not accepted. Please resend the whole group.',
      });
      expect(res.json).toHaveBeenCalledTimes(1);
      expect(mockInputService.ready).toHaveBeenCalledTimes(1);
      if (code === 'source_input_group_conflict') {
        expect(mockInputService.status).toHaveBeenCalledTimes(1);
        expect(mockInputService.status).toHaveBeenCalledWith(
          'user_1',
          { sourceEventId: row.sourceEventId, claimToken: row.claimToken },
          'failed',
          code,
          false,
          [{ sourceEventId: row.sourceEventId, claimToken: row.claimToken }],
        );
      } else {
        expect(mockInputService.status).not.toHaveBeenCalled();
      }
      expect(mockInputService.bindStream).not.toHaveBeenCalled();
      expect(lastAgentId).toBeNull();
    },
  );

  test.each(['source_input_claim_conflict', 'source_input_claim_expired'])(
    'a refused group conflict settlement preserves the exact status guard (%s)',
    async (code) => {
      const row = { ...inputIdentity(), mediaGroupId: 'synthetic-group' };
      const error = Object.assign(new Error('The saved input changed.'), { code, statusCode: 409 });
      mockInputService.read.mockResolvedValue(row);
      mockInputService.ready.mockRejectedValueOnce(
        Object.assign(new Error('Conflicting source group.'), {
          code: 'source_input_group_conflict',
          statusCode: 409,
        }),
      );
      mockInputService.status.mockRejectedValueOnce(error);

      await expect(
        postRetainedInput(row, 'Review this upload group.', {
          inputClaims: [{ sourceEventId: 'f'.repeat(64), claimToken: 'foreign-claim' }],
        }),
      ).rejects.toBe(error);

      expect(mockInputService.status).toHaveBeenCalledWith(
        'user_1',
        { sourceEventId: row.sourceEventId, claimToken: row.claimToken },
        'failed',
        'source_input_group_conflict',
        false,
        [{ sourceEventId: row.sourceEventId, claimToken: row.claimToken }],
      );
      expect(mockInputService.bindStream).not.toHaveBeenCalled();
      expect(lastAgentId).toBeNull();
    },
  );

  test.each([
    'source_input_claim_expired',
    'source_input_owner_changed',
    'source_input_already_admitted',
  ])('other retained ready rejections preserve their original guard (%s)', async (code) => {
    const row = inputIdentity();
    const error = Object.assign(
      new Error('The saved input changed; retry from its current state.'),
      { code, statusCode: 409, body: { code, retryable: true } },
    );
    mockInputService.read.mockResolvedValue(row);
    mockInputService.ready.mockRejectedValueOnce(error);

    await expect(postRetainedInput(row, 'Review this upload.')).rejects.toBe(error);

    expect(mockInputService.status).not.toHaveBeenCalled();
    expect(mockInputService.bindStream).not.toHaveBeenCalled();
    expect(lastAgentId).toBeNull();
  });

  test('POST injects extracted document images from Telegram file uploads into the vision payload', async () => {
    const telegramRouter = require('../telegram');
    const { resizeImageBuffer } = require('~/server/services/Files/images');
    const app = createTestApp(telegramRouter);
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
    const req = createMockReq({
      url: '/api/viventium/telegram/chat',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      body: {
        text: 'review this deck',
        conversationId: 'new',
        telegramUserId: 'tg-1',
        files: [
          {
            filename: 'deck.pptx',
            mime_type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            data: Buffer.from('pptx-bytes').toString('base64'),
          },
        ],
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(resizeImageBuffer).toHaveBeenCalledTimes(1);
    expect(resizeImageBuffer.mock.calls[0][1]).toEqual({ px: 768 });
    expect(lastTelegramImages).toEqual([
      {
        type: 'image_url',
        image_url: {
          url: 'data:image/png;base64,cG5n',
          detail: 'auto',
        },
      },
    ]);
  });

  test('POST persists native Telegram photos as distinct owner-scoped mission files in media-group order', async () => {
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);
    const durableUploadCalls = [];
    mockProcessAgentFileUpload.mockImplementation(async ({ req, res, metadata }) => {
      durableUploadCalls.push([
        req._viventiumBridgeDurableMissionAttachment,
        req.file.originalname,
      ]);
      res.status(200).json({
        message: 'Agent file uploaded and processed successfully',
        file_id: metadata.file_id,
        temp_file_id: metadata.temp_file_id,
        filename: req.file.originalname,
        filepath: `/uploads/user-1/${metadata.file_id}__${req.file.originalname}`,
        type: req.file.mimetype,
        source: 'local',
      });
    });
    const sameBytes = Buffer.from('synthetic-photo-bytes').toString('base64');
    const req = createMockReq({
      url: '/api/viventium/telegram/chat',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      body: {
        text: 'compare these in order',
        conversationId: 'new',
        telegramUserId: 'tg-1',
        files: [
          { filename: 'first.png', mime_type: 'image/png', data: sameBytes },
          { filename: 'second.png', mime_type: 'image/png', data: sameBytes },
        ],
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(mockProcessAgentFileUpload).toHaveBeenCalledTimes(2);
    expect(durableUploadCalls).toEqual([
      [true, 'first.png'],
      [true, 'second.png'],
    ]);
    expect(lastMissionAttachments).toEqual([
      expect.objectContaining({
        filename: 'first.png',
        type: 'image/png',
        viventium_media_group_index: 0,
      }),
      expect.objectContaining({
        filename: 'second.png',
        type: 'image/png',
        viventium_media_group_index: 1,
      }),
    ]);
    expect(lastMissionAttachments[0].file_id).not.toBe(lastMissionAttachments[1].file_id);
    expect(lastTelegramImages).toHaveLength(2);
  });

  test('POST preserves three same-named Telegram photos as three ordered mission files', async () => {
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);
    mockProcessAgentFileUpload.mockImplementation(async ({ req, res, metadata }) => {
      res.status(200).json({
        message: 'Agent file uploaded and processed successfully',
        file_id: metadata.file_id,
        temp_file_id: metadata.temp_file_id,
        filename: req.file.originalname,
        filepath: `/uploads/user-1/${metadata.file_id}__${req.file.originalname}`,
        type: req.file.mimetype,
        source: 'local',
      });
    });
    const files = ['one', 'two', 'three'].map((value) => ({
      filename: 'photo.jpg',
      mime_type: 'image/jpeg',
      data: Buffer.from(value).toString('base64'),
    }));
    const req = createMockReq({
      url: '/api/viventium/telegram/chat',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      body: {
        text: 'compare these in order',
        conversationId: 'new',
        telegramUserId: 'tg-1',
        files,
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(mockProcessAgentFileUpload).toHaveBeenCalledTimes(3);
    expect(lastMissionAttachments).toHaveLength(3);
    expect(lastMissionAttachments.map((file) => file.filename)).toEqual([
      'photo.jpg',
      'photo.jpg',
      'photo.jpg',
    ]);
    expect(lastMissionAttachments.map((file) => file.viventium_media_group_index)).toEqual([
      0, 1, 2,
    ]);
    expect(new Set(lastMissionAttachments.map((file) => file.file_id))).toHaveProperty('size', 3);
    expect(lastTelegramImages).toHaveLength(3);
    expect(lastBridgeDocumentImageExtraction).toBeUndefined();
  });

  test('POST keeps an idle owned conversation and its exact history parent by default', async () => {
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);
    mockGetConvo.mockResolvedValueOnce({ conversationId: 'conv-idle', endpoint: 'agents' });
    mockGetMessages.mockResolvedValueOnce([
      {
        messageId: 'old-answer',
        parentMessageId: 'old-source',
        createdAt: '2026-01-01T12:00:00.000Z',
        isCreatedByUser: false,
      },
    ]);
    const res = createMockRes();
    await dispatch(
      app,
      createMockReq({
        url: '/api/viventium/telegram/chat',
        headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
        body: { text: 'Continue this work.', conversationId: 'conv-idle', telegramUserId: 'tg-1' },
      }),
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.conversationId).toBe('conv-idle');
    expect(lastParentMessageId).toBe('old-answer');
    expect(mockGetConvo).toHaveBeenCalledWith(
      'user_1',
      'conv-idle',
      'conversationId endpoint agent_id user updatedAt',
    );
    expect(mockTelegramIngressUpdateOne.mock.calls[0][1].$set.conversationId).toBe('conv-idle');
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
    expect(res.body.conversationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(mockTelegramIngressUpdateOne.mock.calls[0][1].$set.conversationId).toBe(
      res.body.conversationId,
    );
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
    expect(res.body.code).toBe('TELEGRAM_ACCOUNT_NOT_LINKED');
    expect(res.body.linkRequired).toBe(true);
    expect(res.body.linkUrl).toContain('/api/viventium/telegram/link/');
  });

  test('GET /orchestration returns structured link authority without relying on prose', async () => {
    mockTelegramMappingFindOne.mockReturnValue({
      lean: async () => null,
    });
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);
    const req = createMockReq({
      url: '/api/viventium/telegram/orchestration?telegramUserId=tg-1',
      method: 'GET',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      query: { telegramUserId: 'tg-1' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({
      error: 'Telegram account not linked',
      code: 'TELEGRAM_ACCOUNT_NOT_LINKED',
      linkRequired: true,
    });
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

  test('POST /call-link returns a public deep link after checking assistant access', async () => {
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
    /* === VIVENTIUM START ===
     * Feature: Browser voice launch-capability privacy.
     * Purpose: Keep room and agent authority out of Telegram-visible query parameters;
     * the browser redeems only the opaque call session and fragment capability.
     */
    expect(url.pathname).toBe('/call-bootstrap');
    expect(url.searchParams.get('callSessionId')).toBe('call_session_test');
    expect(url.searchParams.has('roomName')).toBe(false);
    expect(url.searchParams.has('agentName')).toBe(false);
    expect(url.searchParams.get('autoConnect')).toBe('1');
    expect(url.hash).toBe(`#viventiumCallLaunch=${'B'.repeat(43)}`);
    /* === VIVENTIUM END === */
    expect(mockAssertVoiceAgentAccess).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent_default' }),
    );
  });

  test('POST /call-link keeps an existing conversation out of the Telegram-posted launch URL', async () => {
    process.env.VIVENTIUM_PUBLIC_PLAYGROUND_URL = 'https://voice.example.test';
    const app = createTestApp(require('../telegram'));
    const req = createMockReq({
      url: '/api/viventium/telegram/call-link',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      body: {
        conversationId: 'conversation-existing',
        agentId: 'agent_default',
        telegramUserId: 'tg-1',
      },
    });
    const res = createMockRes();
    await dispatch(app, req, res);
    expect(res.statusCode).toBe(200);
    expect(mockCreateCallSession).toHaveBeenCalledWith({
      userId: 'user_1',
      agentId: 'agent_default',
      conversationId: 'conversation-existing',
    });
    expect(res.body.conversationId).toBe('conversation-existing');
    const url = new URL(res.body.playgroundUrl);
    expect(url.searchParams.has('conversationId')).toBe(false);
    expect(url.searchParams.get('callSessionId')).toBe('call_session_test');
    expect(url.hash).toBe(`#viventiumCallLaunch=${'B'.repeat(43)}`);
    expect(res.body.callUrl).toBe(res.body.playgroundUrl);
    expect(mockAssertVoiceAgentAccess).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent_default' }),
    );
  });

  test('POST /call-link denies a foreign or revoked agent before creating call authority', async () => {
    process.env.VIVENTIUM_PUBLIC_PLAYGROUND_URL = 'https://voice.viventium.ai';
    const error = new Error('Voice assistant is unavailable');
    error.status = 404;
    error.code = 'no_route';
    mockAssertVoiceAgentAccess.mockRejectedValueOnce(error);
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);
    const req = createMockReq({
      url: '/api/viventium/telegram/call-link',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      body: { conversationId: 'new', telegramUserId: 'tg-1', agentId: 'agent_foreign' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({
      code: 'no_route',
      message: 'Voice assistant is unavailable.',
      retryable: false,
    });
    expect(mockCreateCallSession).not.toHaveBeenCalled();
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
    expect(res.body.code).toBe('TELEGRAM_ACCOUNT_NOT_LINKED');
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
    expect(mockResolveUserVoiceRoute).toHaveBeenCalledWith('user_1', { includeSources: true });
    expect(res.body.voiceRoute).toEqual({
      stt: { provider: 'assemblyai', variant: 'universal-streaming' },
      tts: { provider: 'cartesia', variant: '6ccbfb76-1fc6-48f7-b71d-91ac6298247b' },
    });
  });

  test('GET /voice-route carries only authenticated owner conversation keyterms', async () => {
    mockResolveVoiceContextKeyterms.mockResolvedValueOnce(['Example Meeting']);
    const app = createTestApp(require('../telegram'));
    const req = createMockReq({
      method: 'GET',
      url: '/api/viventium/telegram/voice-route',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      query: {
        telegramUserId: 'tg-1',
        conversationId: 'conversation-topic',
        userId: 'forged-owner',
      },
    });
    const res = createMockRes();
    await dispatch(app, req, res);
    expect(res.statusCode).toBe(200);
    expect(mockResolveVoiceContextKeyterms).toHaveBeenCalledWith({
      userId: 'user_1',
      conversationId: 'conversation-topic',
    });
    expect(res.body.voiceRoute.contextualKeyterms).toEqual(['Example Meeting']);
  });

  test('GET /voice-route rejects unauthenticated contextual lookup', async () => {
    const app = createTestApp(require('../telegram'));
    const req = createMockReq({
      method: 'GET',
      url: '/api/viventium/telegram/voice-route',
      query: { telegramUserId: 'tg-1', conversationId: 'conversation-topic' },
    });
    const res = createMockRes();
    await dispatch(app, req, res);
    expect(res.statusCode).toBe(401);
    expect(mockResolveVoiceContextKeyterms).not.toHaveBeenCalled();
  });

  test('GET /voice-route returns xAI voice variants for Telegram TTS parity', async () => {
    mockResolveUserVoiceRoute.mockResolvedValueOnce({
      stt: { provider: 'pywhispercpp', variant: 'base.en' },
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
    expect(mockResolveUserVoiceRoute).toHaveBeenCalledWith('user_1', { includeSources: true });
    expect(res.body.voiceRoute).toEqual({
      stt: { provider: 'pywhispercpp', variant: 'base.en' },
      tts: { provider: 'xai', variant: 'Rex' },
    });
  });

  test('POST /chat overrides voiceProvider from the resolved voice route and returns it', async () => {
    mockResolveUserVoiceRoute.mockResolvedValueOnce({
      stt: { provider: 'pywhispercpp', variant: 'base.en' },
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
      stt: { provider: 'pywhispercpp', variant: 'base.en' },
      tts: { provider: 'cartesia', variant: '6ccbfb76-1fc6-48f7-b71d-91ac6298247b' },
    });
  });

  test('POST /chat overrides voiceProvider to xAI and returns saved xAI voice variant', async () => {
    mockResolveUserVoiceRoute.mockResolvedValueOnce({
      stt: { provider: 'pywhispercpp', variant: 'base.en' },
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
      stt: { provider: 'pywhispercpp', variant: 'base.en' },
      tts: { provider: 'xai', variant: 'Eve' },
    });
  });

  test('POST /chat normalizes string voiceMode before saved voice provider injection', async () => {
    mockResolveUserVoiceRoute.mockResolvedValueOnce({
      stt: { provider: 'pywhispercpp', variant: 'base.en' },
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
        voiceMode: 'true',
        voiceProvider: 'openai',
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(lastVoiceMode).toBe(true);
    expect(lastVoiceProvider).toBe('xai');
  });

  test.each(['voice_note', 'text'])(
    'POST /chat binds original %s source and syncs reply voice independently',
    async (inputMode) => {
      const req = createMockReq({
        url: '/api/viventium/telegram/chat',
        headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
        body: {
          text: 'hi',
          conversationId: 'new',
          telegramUserId: 'tg-1',
          telegramChatId: 'tg-1',
          voiceMode: false,
          viventiumInputMode: inputMode,
          reply_voice_with_voice: false,
        },
      });
      const res = createMockRes();
      await dispatch(createTestApp(require('../telegram')), req, res);
      expect(res.statusCode).toBe(200);
      expect(mockLastPreparedBody.viventiumInputMode).toBe(inputMode);
      expect(
        mockTelegramMappingUpdateOne.mock.calls.some(
          ([filter, update]) =>
            filter.telegramUserId === 'tg-1' && update.$set.replyVoiceWithVoice === false,
        ),
      ).toBe(true);
      expect(
        mockTelegramIngressUpdateOne.mock.calls.some(
          ([, update]) => update.$set?.inputMode === inputMode,
        ),
      ).toBe(true);
      expect(lastVoiceMode).toBe(false);
    },
  );

  test('POST /chat injects saved voice provider for Telegram text turns that request audio', async () => {
    mockResolveUserVoiceRoute.mockResolvedValueOnce({
      stt: { provider: 'pywhispercpp', variant: 'base.en' },
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
        voiceMode: false,
        telegramAudioRequested: true,
        voiceProvider: 'openai',
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(lastTelegramAudioRequested).toBe(true);
    expect(lastVoiceProvider).toBe('xai');
    expect(res.body.voiceRoute).toEqual({
      stt: { provider: 'pywhispercpp', variant: 'base.en' },
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

  function exactSavedFailure(row) {
    const responseBinding = {
      streamId: row.streamId,
      responseMessageId: 'saved-error',
      logicalTurnId: 'saved-turn',
      revision: 2,
    };
    mockTelegramIngressFindOne.mockImplementation(() => ({
      lean: async () => ({ ...row, responseBinding }),
    }));
    mockInputMessageRead.mockImplementation(() => ({
      lean: async () => ({
        messageId: 'saved-error',
        content: [
          {
            type: 'error',
            error_class: 'source_context_unavailable',
            error: 'Context unavailable.',
          },
        ],
        metadata: {
          viventium: {
            interactionContext: {
              source_event_id: row.sourceEventId,
              logical_turn_id: 'saved-turn',
              revision: 2,
            },
          },
        },
      }),
    }));
  }
  test('missing Redis host final uses normal terminal SSE and exact retained source without generation', async () => {
    mockGetJob.mockResolvedValue(null);
    const row = { ...inputIdentity(), streamId: 'expired-stream' };
    exactSavedFailure(row);
    const finalEvent = {
      final: true,
      requestMessage: { messageId: row.sourceMessageId },
      responseMessage: {
        messageId: 'saved-error',
        text: 'Saved final',
        attachments: [{ file_id: 'output' }],
      },
    };
    mockReadHostFinal.mockResolvedValue({
      responseMessageId: 'saved-error',
      conversationId: row.conversationId,
      interactionContext: {
        source_event_id: row.sourceEventId,
        logical_turn_id: 'saved-turn',
        revision: 2,
      },
      finalEvent,
    });
    const res = createMockRes();
    await dispatch(
      createTestApp(require('../telegram')),
      createMockReq({
        method: 'GET',
        url: '/api/viventium/telegram/stream/expired-stream?resume=true&telegramUserId=tg-1',
        query: { resume: 'true', telegramUserId: 'tg-1' },
        headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      }),
      res,
    );
    const wire = res.write.mock.calls.map(([text]) => text).join('');
    expect(wire).toContain('event: message');
    expect(wire).toContain('Saved final');
    expect(wire).toContain('output');
    expect(wire).not.toContain('event: error');
    expect(mockSubscribe).not.toHaveBeenCalled();
  });
  test('retained input continuation finds the same host-final stream without generation', async () => {
    mockGetJob.mockResolvedValue(null);
    const row = { ...inputIdentity(), state: 'admitted', streamId: 'expired-stream' };
    const terminal = {
      responseMessageId: 'saved-error',
      conversationId: row.conversationId,
      interactionContext: {
        source_event_id: row.sourceEventId,
        logical_turn_id: 'saved-turn',
        revision: 2,
      },
      finalEvent: {
        final: true,
        requestMessage: { messageId: row.sourceMessageId },
        responseMessage: { text: 'Saved final' },
      },
    };
    mockReadHostFinal.mockResolvedValue(terminal);
    const { res, done } = continueRetainedInput(row, { savedFailure: true });
    await done;
    expect(res.body).toMatchObject({ status: 'duplicate', streamId: 'expired-stream' });
    expect(lastStreamId).toBeNull();
  });

  test('missing Redis stream replays only the saved typed terminal through normal SSE', async () => {
    mockGetJob.mockResolvedValue(null);
    const row = { ...inputIdentity(), streamId: 'expired-stream' };
    exactSavedFailure(row);
    const app = createTestApp(require('../telegram'));
    const res = createMockRes();
    await dispatch(
      app,
      createMockReq({
        method: 'GET',
        url: '/api/viventium/telegram/stream/expired-stream?resume=true&telegramUserId=tg-1',
        query: { resume: 'true', telegramUserId: 'tg-1' },
        headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      }),
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(res.write.mock.calls.map(([text]) => text).join('')).toContain(
      'source_context_unavailable',
    );
    expect(res.write.mock.calls.map(([text]) => text).join('')).toContain('saved-error');
    expect(mockSubscribe).not.toHaveBeenCalled();
  });
  test('retained input continuation with expired Redis returns its existing terminal stream without generation', async () => {
    mockGetJob.mockResolvedValue(null);
    const row = { ...inputIdentity(), state: 'admitted', streamId: 'expired-stream' };
    const { res, done } = continueRetainedInput(row, { savedFailure: true });
    await done;
    expect(res.body).toMatchObject({
      status: 'duplicate',
      streamId: 'expired-stream',
      logical_turn_id: 'saved-turn',
      revision: 2,
    });
    expect(lastStreamId).toBeNull();
    expect(mockInputService.bindStream).not.toHaveBeenCalled();
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
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);
    const req = createMockReq({
      method: 'GET',
      url: '/api/viventium/telegram/stream/closed-during-lookup?telegramUserId=tg-1',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      query: { telegramUserId: 'tg-1' },
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

  test('GET stream decorates SSE with authoritative logical-turn metadata', async () => {
    mockGetJob.mockResolvedValueOnce({
      metadata: {
        userId: 'user_1',
        interactionContext: {
          actor_kind: 'external_user',
          origin: 'interactive',
          surface: 'telegram',
          conversation_id: 'conversation-1',
          logical_turn_id: 'logical-telegram-2',
          revision: 2,
          source_event_id: 'event-2',
        },
      },
    });
    mockSubscribe.mockImplementation(async (_streamId, onChunk, onDone) => {
      onChunk({ event: 'on_message_delta', data: { text: 'hello' } });
      onDone({ final: true });
      return { unsubscribe: jest.fn() };
    });
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);
    const req = createMockReq({
      method: 'GET',
      url: '/api/viventium/telegram/stream/stream_1?telegramUserId=tg-1',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      query: { telegramUserId: 'tg-1' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    const writes = res.write.mock.calls.map((call) => String(call[0] || '')).join('\n');
    expect(writes).toContain('"logical_turn_id":"logical-telegram-2"');
    expect(writes).toContain('"revision":2');
    expect(writes).toContain('"surface":"telegram"');
  });

  test.each([
    [true, true, true],
    [true, true, false],
    [true, false, true],
    [true, false, false],
    [false, true, true],
    [false, true, false],
    [false, false, true],
    [false, false, false],
  ])(
    'POST preferences retains independent master=%s replyVoice=%s always=%s',
    async (master, replyVoice, always) => {
      const req = createMockReq({
        url: '/api/viventium/telegram/preferences',
        headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
        body: {
          telegramUserId: 'tg-1',
          voiceResponsesEnabled: master,
          replyVoiceWithVoice: replyVoice,
          alwaysVoiceResponse: always,
        },
      });
      const res = createMockRes();
      await dispatch(createTestApp(require('../telegram')), req, res);
      expect(res.statusCode).toBe(200);
      expect(res.body.voice_preferences).toEqual({
        voice_responses_enabled: master,
        reply_voice_with_voice: replyVoice,
        always_voice_response: always,
      });
      expect(mockTelegramMappingUpdateOne).toHaveBeenLastCalledWith(
        { telegramUserId: 'tg-1' },
        {
          $set: expect.objectContaining({
            voiceResponsesEnabled: master,
            replyVoiceWithVoice: replyVoice,
            alwaysVoiceResponse: always,
            voicePrefsUpdatedAt: expect.any(Date),
          }),
        },
      );
    },
  );

  test('POST preferences accepts only the new snake alias without resetting legacy values', async () => {
    const req = createMockReq({
      url: '/api/viventium/telegram/preferences',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      body: { telegramUserId: 'tg-1', reply_voice_with_voice: false },
    });
    const res = createMockRes();
    await dispatch(createTestApp(require('../telegram')), req, res);
    expect(res.statusCode).toBe(200);
    const write = mockTelegramMappingUpdateOne.mock.calls.at(-1);
    expect(write[0]).toEqual({ telegramUserId: 'tg-1' });
    expect(write[1].$set.replyVoiceWithVoice).toBe(false);
    expect(write[1].$set).not.toHaveProperty('alwaysVoiceResponse');
    expect(write[1].$set).not.toHaveProperty('voiceResponsesEnabled');
  });

  test('POST preferences rejects a bridge secret mismatch before a mapping write', async () => {
    const req = createMockReq({
      url: '/api/viventium/telegram/preferences',
      headers: { 'x-viventium-telegram-secret': 'invalid_secret' },
      body: { telegramUserId: 'tg-1', replyVoiceWithVoice: false },
    });
    const res = createMockRes();
    await dispatch(createTestApp(require('../telegram')), req, res);
    expect(res.statusCode).toBe(401);
    expect(mockTelegramMappingUpdateOne).not.toHaveBeenCalled();
  });

  test.each(['/chat', '/voice-route'])(
    'group %s context cannot replace private voice preferences',
    async (path) => {
      const identity = {
        telegramUserId: 'tg-1',
        telegramChatId: '-100123',
        alwaysVoiceResponse: false,
        replyVoiceWithVoice: false,
        voiceResponsesEnabled: false,
      };
      const req = createMockReq({
        url: `/api/viventium/telegram${path}`,
        method: path === '/chat' ? 'POST' : 'GET',
        headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
        body: path === '/chat' ? { ...identity, text: 'hi', conversationId: 'new' } : {},
        query: path === '/voice-route' ? identity : {},
      });
      const res = createMockRes();
      await dispatch(createTestApp(require('../telegram')), req, res);
      expect(res.statusCode).toBe(200);
      expect(mockTelegramMappingUpdateOne).toHaveBeenCalled();
      for (const [filter, update] of mockTelegramMappingUpdateOne.mock.calls) {
        expect(filter).toEqual({ telegramUserId: 'tg-1' });
        for (const field of [
          'alwaysVoiceResponse',
          'replyVoiceWithVoice',
          'voiceResponsesEnabled',
          'voicePrefsUpdatedAt',
        ])
          expect(update.$set).not.toHaveProperty(field);
      }
    },
  );

  test.each([
    ['/voice-route', 0, 200],
    ['/voice-route', '0', 200],
    ['/voice-route', '7', 200],
    ['/chat', 0, 400],
    ['/chat', '7', 200],
    ['/source-order', 0, 400],
    ['/source-order', '7', 200],
  ])(
    'topic %s/%s context cannot replace private voice preferences',
    async (path, telegramMessageThreadId, status) => {
      const identity = {
        telegramUserId: 'tg-1',
        telegramChatId: 'tg-1',
        telegramMessageThreadId,
        sourceSequence: 42,
        alwaysVoiceResponse: false,
        replyVoiceWithVoice: false,
        voiceResponsesEnabled: false,
      };
      const req = createMockReq({
        url: `/api/viventium/telegram${path}`,
        method: path === '/voice-route' ? 'GET' : 'POST',
        headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
        body: path === '/voice-route' ? {} : { ...identity, text: 'hi', conversationId: 'new' },
        query: path === '/voice-route' ? identity : {},
      });
      const res = createMockRes();
      await dispatch(createTestApp(require('../telegram')), req, res);
      expect(res.statusCode).toBe(status);
      expect(mockTelegramMappingUpdateOne).toHaveBeenCalled();
      for (const [filter, update] of mockTelegramMappingUpdateOne.mock.calls) {
        expect(filter).toEqual({ telegramUserId: 'tg-1' });
        for (const field of [
          'alwaysVoiceResponse',
          'replyVoiceWithVoice',
          'voiceResponsesEnabled',
          'voicePrefsUpdatedAt',
        ])
          expect(update.$set).not.toHaveProperty(field);
      }
    },
  );

  test('snake-case topic identity also protects private context preferences', async () => {
    const req = createMockReq({
      url: '/api/viventium/telegram/voice-route',
      method: 'GET',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      query: {
        telegramUserId: 'tg-1',
        telegramChatId: 'tg-1',
        telegram_message_thread_id: '7',
        always_voice_response: false,
        reply_voice_with_voice: false,
        voice_responses_enabled: false,
      },
    });
    const res = createMockRes();
    await dispatch(createTestApp(require('../telegram')), req, res);
    expect(res.statusCode).toBe(200);
    const update = mockTelegramMappingUpdateOne.mock.calls.at(-1)[1].$set;
    expect(update).not.toHaveProperty('voicePrefsUpdatedAt');
    expect(update).not.toHaveProperty('alwaysVoiceResponse');
  });

  test.each(['tg-1', undefined])(
    'private voice context %s updates the owner and preserves absent-chat compatibility',
    async (telegramChatId) => {
      const req = createMockReq({
        url: '/api/viventium/telegram/voice-route',
        method: 'GET',
        headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
        query: {
          telegramUserId: 'tg-1',
          telegramChatId,
          always_voice_response: false,
          reply_voice_with_voice: true,
          voice_responses_enabled: true,
        },
      });
      const res = createMockRes();
      await dispatch(createTestApp(require('../telegram')), req, res);
      expect(res.statusCode).toBe(200);
      expect(mockTelegramMappingUpdateOne).toHaveBeenLastCalledWith(
        { telegramUserId: 'tg-1' },
        {
          $set: expect.objectContaining({
            alwaysVoiceResponse: false,
            replyVoiceWithVoice: true,
            voiceResponsesEnabled: true,
            voicePrefsUpdatedAt: expect.any(Date),
          }),
        },
      );
    },
  );

  test('explicit preferences writes the actual owner even from a group control context', async () => {
    const req = createMockReq({
      url: '/api/viventium/telegram/preferences',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      body: {
        telegramUserId: 'tg-1',
        telegramChatId: '-100123',
        telegramMessageThreadId: '7',
        alwaysVoiceResponse: false,
        replyVoiceWithVoice: true,
        voiceResponsesEnabled: true,
      },
    });
    const res = createMockRes();
    await dispatch(createTestApp(require('../telegram')), req, res);
    expect(res.statusCode).toBe(200);
    expect(mockTelegramMappingUpdateOne).toHaveBeenLastCalledWith(
      { telegramUserId: 'tg-1' },
      {
        $set: expect.objectContaining({
          alwaysVoiceResponse: false,
          replyVoiceWithVoice: true,
          voiceResponsesEnabled: true,
        }),
      },
    );
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

  test('GET orchestration reads the linked account-wide mode without a model call', async () => {
    mockGetUserById.mockResolvedValue({
      _id: 'user_1',
      role: 'USER',
      personalization: { orchestration_mode: 'parallel' },
    });
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);
    const req = createMockReq({
      method: 'GET',
      url: '/api/viventium/telegram/orchestration?telegramUserId=tg-1',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      query: { telegramUserId: 'tg-1' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ available: true, mode: 'parallel', hasKnownWork: false });
    expect(res.headers['Cache-Control']).toContain('no-store');
  });

  test('GET and PATCH expose operational owner readiness independently of local QA certification', async () => {
    writeReleaseSnapshot({
      mode: 'local-qa',
      label: 'PRE-GATE / NOT READY',
      release_ready: false,
      exposure_allowed: true,
      local_qa_override: true,
    });
    mockGetUserById.mockResolvedValue({
      _id: 'user_1',
      role: 'USER',
      personalization: { orchestration_mode: 'parallel' },
    });
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);
    const readReq = createMockReq({
      method: 'GET',
      url: '/api/viventium/telegram/orchestration?telegramUserId=tg-1',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      query: { telegramUserId: 'tg-1' },
    });
    const readRes = createMockRes();

    await dispatch(app, readReq, readRes);

    expect(readRes.statusCode).toBe(200);
    expect(readRes.body).toEqual({ available: true, mode: 'parallel', hasKnownWork: false });

    const writeReq = createMockReq({
      method: 'PATCH',
      url: '/api/viventium/telegram/orchestration',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      body: { telegramUserId: 'tg-1', mode: 'parallel' },
    });
    const writeRes = createMockRes();
    await dispatch(app, writeReq, writeRes);
    expect(writeRes.statusCode).toBe(200);
    expect(writeRes.body).toEqual({ available: true, mode: 'parallel', hasKnownWork: false });
    expect(mockUpdateOrchestrationPreferences).toHaveBeenCalledTimes(1);
  });

  test('GET and PATCH preserve operational owner readiness while a release gate remains open', async () => {
    const gate = openGate('PWK-UC-014');
    const gates = validGates().map((item) => (item.case_id === gate.case_id ? gate : item));
    writeReleaseSnapshot({
      mode: 'local-qa',
      label: 'PRE-GATE / NOT READY',
      release_ready: false,
      exposure_allowed: true,
      local_qa_override: true,
      gate_count: gates.length,
      open_gate_count: 1,
      gates,
      open_gates: [gate],
    });
    mockGetUserById.mockResolvedValue({
      _id: 'user_1',
      role: 'USER',
      personalization: { orchestration_mode: 'parallel' },
    });
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);
    const readReq = createMockReq({
      method: 'GET',
      url: '/api/viventium/telegram/orchestration?telegramUserId=tg-1',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      query: { telegramUserId: 'tg-1' },
    });
    const readRes = createMockRes();

    await dispatch(app, readReq, readRes);

    expect(readRes.body).toEqual({ available: true, mode: 'parallel', hasKnownWork: false });

    const writeReq = createMockReq({
      method: 'PATCH',
      url: '/api/viventium/telegram/orchestration',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      body: { telegramUserId: 'tg-1', mode: 'parallel' },
    });
    const writeRes = createMockRes();
    await dispatch(app, writeReq, writeRes);

    expect(writeRes.statusCode).toBe(200);
    expect(writeRes.body).toEqual({ available: true, mode: 'parallel', hasKnownWork: false });
    expect(mockUpdateOrchestrationPreferences).toHaveBeenCalledTimes(1);
  });

  test('PATCH orchestration persists only the linked account and disabling does not cancel work', async () => {
    mockUpdateOrchestrationPreferences.mockResolvedValue({
      personalization: { orchestration_mode: 'focused' },
    });
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);
    const req = createMockReq({
      method: 'PATCH',
      url: '/api/viventium/telegram/orchestration',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      body: { telegramUserId: 'tg-1', mode: 'focused' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ available: true, mode: 'focused', hasKnownWork: false });
    expect(mockUpdateOrchestrationPreferences).toHaveBeenCalledWith('user_1', {
      mode: 'focused',
    });
    expect(mockRequestAccountApi).not.toHaveBeenCalled();
  });

  test('GET preserves the saved Parallel preference and known work during an owner outage', async () => {
    process.env.VIVENTIUM_PARALLEL_WORK_AVAILABLE = 'false';
    fs.unlinkSync(releasePath);
    mockGetUserById.mockResolvedValue({
      _id: 'user_1',
      role: 'USER',
      personalization: { orchestration_mode: 'parallel', parallel_work_known: true },
    });
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);
    const req = createMockReq({
      method: 'GET',
      url: '/api/viventium/telegram/orchestration?telegramUserId=tg-1',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      query: { telegramUserId: 'tg-1' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.body).toEqual({
      available: false,
      mode: 'parallel',
      hasKnownWork: true,
      releaseGate: { label: 'NOT READY', blockers: ['operational_readiness_unavailable'] },
    });
    expect(mockUpdateOrchestrationPreferences).not.toHaveBeenCalled();
  });

  test('PATCH orchestration refreshes stale readiness before rejecting a linked enable', async () => {
    process.env.VIVENTIUM_PARALLEL_WORK_AVAILABLE = 'false';
    mockRefreshOrchestrationReadiness.mockImplementationOnce(async () => {
      process.env.VIVENTIUM_PARALLEL_WORK_AVAILABLE = 'true';
      return { available: true };
    });
    mockUpdateOrchestrationPreferences.mockResolvedValue({
      personalization: { orchestration_mode: 'parallel' },
    });
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);
    const req = createMockReq({
      method: 'PATCH',
      url: '/api/viventium/telegram/orchestration',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      body: { telegramUserId: 'tg-1', mode: 'parallel' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(mockRefreshOrchestrationReadiness).toHaveBeenCalledWith({ ownerId: 'user_1' });
    expect(mockUpdateOrchestrationPreferences).toHaveBeenCalledWith('user_1', {
      mode: 'parallel',
    });
    expect(res.body).toEqual({ available: true, mode: 'parallel', hasKnownWork: false });
  });

  test('GET orchestration work preserves unavailable truth for the linked owner', async () => {
    mockGetActiveWorkInteractiveSnapshot.mockResolvedValue({
      snapshot: 'unavailable',
      work: null,
      overflowCount: null,
    });
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);
    const req = createMockReq({
      method: 'GET',
      url: '/api/viventium/telegram/orchestration/work?telegramUserId=tg-1',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      query: { telegramUserId: 'tg-1' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.body).toEqual({ snapshot: 'unavailable', work: null, overflowCount: null });
    expect(mockGetActiveWorkInteractiveSnapshot).toHaveBeenCalledWith({ ownerId: 'user_1' });
  });

  test('GET orchestration work pages with an opaque cursor without changing account scope', async () => {
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);
    const req = createMockReq({
      method: 'GET',
      url: '/api/viventium/telegram/orchestration/work?telegramUserId=tg-1&cursor=signed.next-page&limit=20',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      query: { telegramUserId: 'tg-1', cursor: 'signed.next-page', limit: '20' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(mockGetActiveWorkPage).toHaveBeenCalledWith({
      ownerId: 'user_1',
      cursor: 'signed.next-page',
      limit: 20,
    });
    expect(res.body.work).toEqual([expect.objectContaining({ workRef: 'work-next' })]);
  });

  test('POST orchestration action derives trusted idempotency and uses canonical work endpoint', async () => {
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);
    const req = createMockReq({
      url: '/api/viventium/telegram/orchestration/work/ghw_test/actions',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      body: {
        telegramUserId: 'tg-1',
        action: 'message',
        instruction: 'Add the new source without interrupting.',
        operationId: '018f47d3-8965-7f6a-a826-7c06afedc001',
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(202);
    expect(mockBuildTrustedActionIdempotencyKey).toHaveBeenCalledWith({
      ownerId: 'user_1',
      workRef: 'ghw_test',
      action: 'message',
      operationId: '018f47d3-8965-7f6a-a826-7c06afedc001',
    });
    expect(mockRequestAccountApi).toHaveBeenCalledWith({
      ownerId: 'user_1',
      path: '/v1/work/ghw_test/actions',
      method: 'POST',
      body: {
        action: 'message',
        instruction: 'Add the new source without interrupting.',
        idempotencyKey: 'trusted-action-key',
        sourceContext: {
          version: 1,
          originRef: 'ghi_original_telegram_launch',
          sourceEventId: expect.stringMatching(/^work_action_event_[a-f0-9]{64}$/),
          sourceRevision: 1,
          surface: 'telegram',
          outputContract: { mode: 'inherit' },
        },
      },
    });
  });

  test('POST native owner input preserves the exact response and pending ACK under normal linked auth', async () => {
    const nativeInput = {
      version: 1,
      requestId: 'permission-1',
      requestFingerprint: 'a'.repeat(64),
      action: 'accept',
      content: { optionId: 'reject_once' },
    };
    mockRequestAccountApi.mockResolvedValue({ status: 'pending', confirmationPending: true });
    const req = createMockReq({
      url: '/api/viventium/telegram/orchestration/work/ghw_test/actions',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      body: {
        telegramUserId: 'tg-1',
        action: 'resume',
        operationId: '018f47d3-8965-7f6a-a826-7c06afedc003',
        nativeInput,
      },
    });
    const res = createMockRes();
    await dispatch(createTestApp(require('../telegram')), req, res);
    expect(res.statusCode).toBe(202);
    expect(res.body).toEqual({ status: 'pending', confirmationPending: true });
    expect(mockRequestAccountApi).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ownerId: 'user_1',
        ownerNativeInput: nativeInput,
        body: expect.objectContaining({ action: 'resume', nativeInput }),
      }),
    );
  });

  test.each([
    {
      action: 'stop',
      nativeInput: {
        version: 1,
        requestId: 'permission-1',
        requestFingerprint: 'a'.repeat(64),
        action: 'decline',
      },
    },
    {
      action: 'resume',
      nativeInput: {
        version: 1,
        requestId: 'permission-1',
        requestFingerprint: 'foreign',
        action: 'decline',
      },
    },
    { action: 'resume', ownerInputControl: true },
  ])('POST rejects forged or incompatible native owner input %#', async (body) => {
    const req = createMockReq({
      url: '/api/viventium/telegram/orchestration/work/ghw_test/actions',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      body: {
        telegramUserId: 'tg-1',
        operationId: '018f47d3-8965-7f6a-a826-7c06afedc003',
        ...body,
      },
    });
    const res = createMockRes();
    await dispatch(createTestApp(require('../telegram')), req, res);
    expect(res.statusCode).toBe(400);
    expect(mockRequestAccountApi).not.toHaveBeenCalled();
  });

  test('POST orchestration dismiss cannot bypass unsettled Core delivery truth', async () => {
    mockGetCoreWorkDelivery.mockResolvedValueOnce({ state: 'pending' });
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);
    const req = createMockReq({
      url: '/api/viventium/telegram/orchestration/work/ghw_test/actions',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      body: {
        telegramUserId: 'tg-1',
        action: 'dismiss',
        operationId: '018f47d3-8965-7f6a-a826-7c06afedc002',
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('glasshive_dismiss_delivery_not_settled');
    expect(mockRequestAccountApi).not.toHaveBeenCalled();
  });

  test('POST orchestration auth Resume uses the canonical exact-scope reauthorization path', async () => {
    mockRequestAccountApi
      .mockResolvedValueOnce({
        attention: { kind: 'auth', code: 'capability_authorization_horizon_expired' },
      })
      .mockResolvedValueOnce({ workRef: 'ghw_test', state: 'queued' });
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);
    const req = createMockReq({
      url: '/api/viventium/telegram/orchestration/work/ghw_test/actions',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      body: {
        telegramUserId: 'tg-1',
        action: 'resume',
        operationId: '018f47d3-8965-7f6a-a826-7c06afedc003',
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(202);
    expect(mockReauthorizeCapabilityAuthorization).toHaveBeenCalledWith({
      ownerId: 'user_1',
      workRef: 'ghw_test',
    });
    expect(mockRequestAccountApi).toHaveBeenNthCalledWith(2, {
      ownerId: 'user_1',
      path: '/v1/work/ghw_test/actions',
      method: 'POST',
      body: {
        action: 'resume',
        idempotencyKey: 'trusted-action-key',
        capabilityReauthorization: {
          version: 1,
          authorizationRef: 'gha_authorization',
          maxExpiresAt: '2026-08-14T00:00:00.000Z',
          scopeFingerprint: 'scope-fingerprint',
        },
      },
    });
  });

  test('GET cortex returns cortex parts and follow-up', async () => {
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);

    mockGetMessages.mockResolvedValueOnce([
      {
        messageId: 'msg-1',
        conversationId: 'conv-1',
        text: 'Canonical telegram response',
        content: [{ type: 'cortex_brewing', status: 'brewing' }],
      },
    ]);
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
      'metadata.viventium.followUpSource': {
        $nin: ['durable_terminal_callback', 'durable_work_callback'],
      },
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
            callbackId: 'cb-telegram-1',
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
    expect(res.body.latest.callbackId).toBe('cb-telegram-1');
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

  test('POST glasshive claim wakes a bounded waiting request and retains exact claim ownership', async () => {
    const app = createTestApp(require('../telegram'));
    mockClaimGlassHiveDeliveries
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ deliveryId: 'wake-one', claimId: 'claim-one' }]);
    const req = createMockReq({
      method: 'POST',
      url: '/api/viventium/telegram/glasshive/deliveries/claim',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      body: { limit: 2, dispatcherId: 'dispatcher-wake', callbackId: 'callback-wake', waitMs: 1 },
    });
    const res = createMockRes();
    await dispatch(app, req, res);
    expect(res.body).toEqual({
      deliveries: [{ deliveryId: 'wake-one', claimId: 'claim-one' }],
      waitSupported: true,
    });
    expect(res.headers['Cache-Control']).toBe('no-store, private');
    expect(mockClaimGlassHiveDeliveries).toHaveBeenCalledTimes(2);
    for (const [claim] of mockClaimGlassHiveDeliveries.mock.calls) {
      expect(claim).toMatchObject({
        surface: 'telegram',
        limit: 2,
        claimOwner: 'dispatcher-wake',
        callbackId: 'callback-wake',
      });
    }
  });

  test('POST glasshive waiting claim requires the existing bridge secret', async () => {
    const app = createTestApp(require('../telegram'));
    const req = createMockReq({
      method: 'POST',
      url: '/api/viventium/telegram/glasshive/deliveries/claim',
      body: { waitMs: 5000 },
    });
    const res = createMockRes();
    await dispatch(app, req, res);
    expect(res.statusCode).toBe(401);
    expect(mockClaimGlassHiveDeliveries).not.toHaveBeenCalled();
  });

  test('POST cortex delivery claim uses bridge secret and returns only service-authorized work', async () => {
    const delivery = {
      deliveryId: 'cidl-1',
      streamId: 'telegram-stream-1',
      telegramChatId: '-100123',
      text: 'Useful late result.',
      cortexPresentation: { deliveryIds: ['cidl-1'], claimToken: 'claim-1' },
    };
    mockClaimCortexTelegramDeliveries.mockResolvedValueOnce([delivery]);
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);
    const req = createMockReq({
      method: 'POST',
      url: '/api/viventium/telegram/cortex/deliveries/claim',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      body: { limit: 5, leaseMs: 90000 },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ deliveries: [delivery] });
    expect(mockClaimCortexTelegramDeliveries).toHaveBeenCalledWith({ limit: 5, leaseMs: 90000 });
  });

  test('POST cortex delivery authorize returns the exact pre-transport presentation permit', async () => {
    const cortexClaim = {
      ownerId: 'owner-1',
      messageId: 'followup-1',
      parentMessageId: 'parent-1',
      revision: 2,
      generation: 3,
      deliveryIds: ['cidl-1'],
      deliveryReceipts: [{ deliveryId: 'cidl-1', graphResultHash: 'a'.repeat(64) }],
      claimToken: 'claim-3',
      surface: 'telegram',
    };
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);
    const req = createMockReq({
      method: 'POST',
      url: '/api/viventium/telegram/cortex/deliveries/authorize',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      body: { cortexClaim, leaseMs: 90000 },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.cortexPresentation.presentationLeaseToken).toBe('lease-3');
    expect(mockAuthorizeCortexTelegramDeliveryClaim).toHaveBeenCalledWith({
      cortexClaim,
      leaseMs: 90000,
    });
  });

  test.each(['failed', 'suppressed'])(
    'POST cortex delivery status settles the exact %s claim',
    async (status) => {
      const telegramRouter = require('../telegram');
      const app = createTestApp(telegramRouter);
      const cortexPresentation = {
        ownerId: 'owner-1',
        messageId: 'followup-1',
        parentMessageId: 'parent-1',
        revision: 2,
        generation: 3,
        claimToken: 'claim-3',
        presentationLeaseToken: 'lease-3',
        deliveryIds: ['cidl-1'],
        deliveryReceipts: [{ deliveryId: 'cidl-1', graphResultHash: 'a'.repeat(64) }],
      };
      const req = createMockReq({
        method: 'POST',
        url: '/api/viventium/telegram/cortex/deliveries/status',
        headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
        body: { status, cortexPresentation },
      });
      const res = createMockRes();

      await dispatch(app, req, res);

      expect(res.statusCode).toBe(200);
      const expected =
        status === 'failed'
          ? mockFailCortexTelegramDeliveryClaim
          : mockSuppressCortexTelegramDeliveryClaim;
      expect(expected).toHaveBeenCalledWith(
        status === 'failed'
          ? { cortexPresentation, reason: 'presentation_failed' }
          : { cortexPresentation, dropReason: 'conversation_moved_on' },
      );
    },
  );

  test('POST cortex delivery status terminally records an authorized unknown outcome', async () => {
    const cortexPresentation = {
      ownerId: 'owner-1',
      messageId: 'followup-1',
      parentMessageId: 'parent-1',
      revision: 2,
      generation: 3,
      claimToken: 'claim-3',
      presentationLeaseToken: 'lease-3',
      deliveryIds: ['cidl-1'],
      deliveryReceipts: [{ deliveryId: 'cidl-1', graphResultHash: 'a'.repeat(64) }],
      surface: 'telegram',
    };
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);
    const req = createMockReq({
      method: 'POST',
      url: '/api/viventium/telegram/cortex/deliveries/status',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      body: { status: 'delivery_unknown', cortexPresentation },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(mockMarkCortexTelegramDeliveryUnknown).toHaveBeenCalledWith({ cortexPresentation });
  });

  test('POST glasshive delivery authorize returns a generation-bound final-send permit', async () => {
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);
    const req = createMockReq({
      method: 'POST',
      url: '/api/viventium/telegram/glasshive/deliveries/ghcd_1/authorize',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      body: { claimId: 'claim-1', leaseMs: 45000 },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.permit).toMatchObject({
      deliveryId: 'ghcd_1',
      claimId: 'claim-1',
      surface: 'telegram',
      resultRevision: 2,
    });
    expect(mockAuthorizeGlassHiveDeliveryDispatch).toHaveBeenCalledWith({
      deliveryId: 'ghcd_1',
      claimId: 'claim-1',
      leaseMs: 45000,
    });
  });

  test('POST glasshive delivery authorize rejects a stale revision before Telegram send', async () => {
    mockAuthorizeGlassHiveDeliveryDispatch.mockResolvedValueOnce(null);
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);
    const req = createMockReq({
      method: 'POST',
      url: '/api/viventium/telegram/glasshive/deliveries/ghcd_stale/authorize',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      body: { claimId: 'claim-stale' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe('delivery_dispatch_not_authorized');
  });

  test('POST glasshive delivery permit renew and release preserve the exact token', async () => {
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);
    const dispatchPermit = { permitId: 'a'.repeat(32), permitGeneration: 2 };
    const renewReq = createMockReq({
      method: 'POST',
      url: '/api/viventium/telegram/glasshive/deliveries/ghcd_1/renew',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      body: { claimId: 'claim-1', dispatchPermit, leaseMs: 45000 },
    });
    const renewRes = createMockRes();

    await dispatch(app, renewReq, renewRes);

    expect(renewRes.statusCode).toBe(200);
    expect(mockRenewGlassHiveDeliveryDispatch).toHaveBeenCalledWith({
      deliveryId: 'ghcd_1',
      claimId: 'claim-1',
      dispatchPermit,
      leaseMs: 45000,
    });

    const releaseReq = createMockReq({
      method: 'POST',
      url: '/api/viventium/telegram/glasshive/deliveries/ghcd_1/release',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      body: { claimId: 'claim-1', dispatchPermit },
    });
    const releaseRes = createMockRes();

    await dispatch(app, releaseReq, releaseRes);

    expect(releaseRes.statusCode).toBe(200);
    expect(releaseRes.body).toEqual({ released: true });
    expect(mockReleaseGlassHiveDeliveryDispatch).toHaveBeenCalledWith({
      deliveryId: 'ghcd_1',
      claimId: 'claim-1',
      dispatchPermit,
    });
  });

  test('POST glasshive delivery status marks sent by delivery claim id', async () => {
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);
    const req = createMockReq({
      method: 'POST',
      url: '/api/viventium/telegram/glasshive/deliveries/ghcd_1/status',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      body: {
        claimId: 'claim-1',
        status: 'sent',
        telegramMessageIds: ['501', '502'],
        dispatchPermit: { permitId: 'a'.repeat(32), permitGeneration: 2 },
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(mockMarkGlassHiveDeliverySent).toHaveBeenCalledWith({
      deliveryId: 'ghcd_1',
      claimId: 'claim-1',
      telegramMessageIds: ['501', '502'],
      dispatchPermit: { permitId: 'a'.repeat(32), permitGeneration: 2 },
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
      body: {
        claimId: 'claim-stale',
        status: 'sent',
        telegramMessageIds: ['503'],
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe('delivery_not_claimed');
  });

  test('POST glasshive delivery status records an ambiguous Telegram outcome', async () => {
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);
    const req = createMockReq({
      method: 'POST',
      url: '/api/viventium/telegram/glasshive/deliveries/ghcd_1/status',
      headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
      body: {
        claimId: 'claim-unknown',
        status: 'delivery_unknown',
        dispatchPermit: { permitId: 'a'.repeat(32), permitGeneration: 2 },
        reason: 'telegram_receipt_missing_after_send',
        telegramMessageIds: ['701'],
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(mockMarkGlassHiveDeliveryUnknown).toHaveBeenCalledWith({
      deliveryId: 'ghcd_1',
      claimId: 'claim-unknown',
      dispatchPermit: { permitId: 'a'.repeat(32), permitGeneration: 2 },
      reason: 'telegram_receipt_missing_after_send',
      telegramMessageIds: ['701'],
    });
  });

  test('GET cortex resolves deferred fallback canonical text when follow-up is absent', async () => {
    const telegramRouter = require('../telegram');
    const app = createTestApp(telegramRouter);

    mockGetMessages.mockResolvedValueOnce([
      {
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
      },
    ]);
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

    mockGetMessages.mockResolvedValueOnce([
      {
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
      },
    ]);
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

    mockGetMessages.mockResolvedValueOnce([
      {
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
      },
    ]);
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
  /* === VIVENTIUM START: Preserve the shared public stream failure contract. === */

  test.each(['source_context_unavailable', undefined])(
    'GET stream preserves optional typed generation failure %s',
    async (errorClass) => {
      const error = 'The conversation context could not be preserved. Please retry this turn.';
      mockSubscribe.mockImplementation(async (_id, _event, _done, onError) => {
        onError(error, errorClass);
        return { unsubscribe: jest.fn() };
      });
      const app = createTestApp(require('../telegram'));
      const req = createMockReq({
        method: 'GET',
        url: '/api/viventium/telegram/stream/typed-failure?telegramUserId=tg-1',
        headers: { 'x-viventium-telegram-secret': 'telegram_secret' },
        query: { telegramUserId: 'tg-1' },
      });
      const res = createMockRes();
      await dispatch(app, req, res);
      const errorFrames = res.write.mock.calls
        .map(([value]) => value)
        .filter((value) => value.startsWith('event: error\ndata: '));
      expect(errorFrames).toHaveLength(1);
      expect(JSON.parse(errorFrames[0].slice('event: error\ndata: '.length))).toEqual({
        error,
        ...(errorClass ? { error_class: errorClass } : {}),
      });
    },
  );
  /* === VIVENTIUM END === */
});
