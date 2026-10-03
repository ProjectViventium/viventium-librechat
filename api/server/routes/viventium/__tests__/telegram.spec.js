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
let mockReplyReceiptFindOne;
let mockRetainLogicalTurnInput;
let mockMutateNativeResponseSources;
let mockLastPreparedBody;
let mockCaptureAcceptedInteractionInput;
let mockRetainAcceptedInteractionInput;
let mockLastAdapterCapabilities = null;
let mockLastDeliveryPolicy = null;
let mockClaimedLogicalTurn = null;
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
jest.mock('~/server/services/viventium/nativeResponseService', () => ({
  mutateNativeResponseSources: (...args) => mockMutateNativeResponseSources(...args),
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
    releaseFixture.reset();
  });

  afterAll(() => {
    releaseFixture.cleanup();
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
    expect(mockRetainAcceptedInteractionInput).not.toHaveBeenCalled();
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
            preparation: { version: 1 },
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
    { preparation = { message: { date: 1700000000 } }, body = {}, envelope = {} } = {},
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
    [{ $set: { authorityBoundAt: { $ifNull: ['$authorityBoundAt', '$$NOW'] } } }],
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
        },
        adapterCapabilities: { segment_stability: 'provisional', supersede_scope: 'response_only' },
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

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
    });
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
  test('a fresh input lets an earlier input finish preparing and joins the turn before it is ready', async () => {
    const row = inputIdentity();
    mockInputService.read.mockResolvedValue(row);
    mockInputService.ready.mockResolvedValue({ ...row, state: 'ready' });
    mockInputService.hasEarlierPreparingInput
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);
    await postRetainedInput(row, 'Correction: use 80 booklets.');
    expect(mockInputService.hasEarlierPreparingInput).toHaveBeenCalledTimes(3);
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
    expect(lastAgentId).not.toBeNull();
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
  const recoverStaleInput = async (row, source = null) => {
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
    mockGetMessages.mockResolvedValue([]);
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
    await recoverStaleInput(row, { ...source, parentMessageId: 'another-parent' });
    expect(mockMutateNativeResponseSources).toHaveBeenCalledTimes(1);
    expect(mockMutateNativeResponseSources).toHaveBeenCalledWith(
      mockInputService.messageFilter(row),
      expect.any(Function),
    );
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
