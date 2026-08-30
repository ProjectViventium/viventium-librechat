/* === VIVENTIUM START ===
 * Feature: Voice ingress route tests (/api/viventium/voice)
 * Added: 2026-03-26
 * === VIVENTIUM END === */

const express = require('express');
const { EventEmitter } = require('events');

let mockAssertVoiceGatewayAuth;
let mockAbandonVoiceSessionClaim;
let mockReportVoiceSessionFailure;
let mockMarkVoiceSessionReady;
let mockGetUserById;
let mockSaveMessage;
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
let mockPersistSpeakerSegments;
let mockProjectSpeakerSegmentRevisions;
let mockListSpeakerSegments;
let mockPersistSpeakerSessionState;
let mockSpeakerPersisted;
let mockSpeakerPersistedAtController;
let mockLastParentMessageId = null;
let mockLastConversationId = null;
let mockLastAgentId = null;
let mockLastRequestText = null;
let mockLastStreamId = null;
let mockLastCanAuthorizeSideEffects = null;
let mockLastActorTrust = null;
let mockLastAmbientContext = null;
let mockLastCallSessionId = null;
let mockLastInteractionContext = null;
let mockLastAdapterCapabilities = null;
let mockLastDeliveryPolicy = null;
let mockClaimedLogicalTurn = null;
let mockAgentControllerCallCount = 0;
let mockAgentControllerResponseDelayMs = 0;
let mockAgentControllerGeneratedConversationId = null;
let mockClaimGlassHiveDeliveries;
let mockMarkGlassHiveDeliverySent;
let mockMarkGlassHiveDeliveryFailed;
let mockMarkGlassHiveDeliverySuppressed;
let mockObservedInfoLogs;
let mockConsoleLogSpy;
let mockRequireVoiceAgentAccess;
let mockBackgroundActivationPolicy;
let mockCheckVoiceEngagement;
let mockGetCallSession;
let mockGetCallSessionVoiceSettings;
let mockCreateVoiceEngagementAttestation;
let mockVerifyVoiceEngagementAttestation;
let mockRecordVoiceOrchestrationTrace;
let mockRecordVoiceOrchestrationTraceBestEffort;
let mockRunVoiceClassifierFaultControl;
let mockCurrentVoiceOrchestrationTraceBinding;
let mockActualApi;

jest.mock(
  '@librechat/data-schemas',
  () => ({
    ...jest.requireActual('@librechat/data-schemas'),
    logger: {
      debug: jest.fn(),
      info: jest.fn((...args) => {
        mockObservedInfoLogs.push(args.map(String).join(' '));
      }),
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
      ...(mockBackgroundActivationPolicy
        ? {
            viventium: {
              background_cortices: {
                activation_policy: mockBackgroundActivationPolicy,
                activation_subject_rule: {
                  enabled: true,
                  prompt: 'BACKGROUND_ONLY_DECISION_SUBJECT',
                },
              },
            },
          }
        : {}),
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
  mockAgentControllerCallCount += 1;
  mockSpeakerPersistedAtController = mockSpeakerPersisted;
  mockLastParentMessageId = req.body.parentMessageId;
  mockLastConversationId = req.body.conversationId;
  mockLastAgentId = req.body.agent_id;
  mockLastRequestText = req.body.text;
  mockLastStreamId = req.body.streamId;
  mockLastCanAuthorizeSideEffects = req.body.viventiumCanAuthorizeSideEffects;
  mockLastActorTrust = req.body.viventiumActorTrust;
  mockLastAmbientContext = req.body.viventiumAmbientContext;
  mockLastCallSessionId = req.body.viventiumCallSessionId;
  const respond = () =>
    res.json({
      streamId: req.body.streamId || 'stream_voice_1',
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
  abandonVoiceSessionClaim: (...args) => mockAbandonVoiceSessionClaim(...args),
  assertCallSessionSecret: jest.fn(),
  assertCallBrowserCapability: jest.fn(async (callSessionId) => ({ callSessionId })),
  createVoiceEngagementAttestation: (...args) => mockCreateVoiceEngagementAttestation(...args),
  claimVoiceSession: jest.fn(),
  getCallSession: (...args) => mockGetCallSession(...args),
  getCallSessionVoiceSettings: (...args) => mockGetCallSessionVoiceSettings(...args),
  heartbeatCallSession: jest.fn(async ({ currentSession }) => currentSession),
  reportVoiceSessionFailure: (...args) => mockReportVoiceSessionFailure(...args),
  markVoiceSessionReady: (...args) => mockMarkVoiceSessionReady(...args),
  assertVoiceGatewayAuth: (...args) => mockAssertVoiceGatewayAuth(...args),
  verifyVoiceEngagementAttestation: (...args) => mockVerifyVoiceEngagementAttestation(...args),
  materializeCallSessionConversationId: jest
    .fn()
    .mockImplementation((_callSessionId, conversationId) => Promise.resolve({ conversationId })),
  claimOrReplaceCallSessionConversationId: jest
    .fn()
    .mockImplementation((_callSessionId, conversationId) => Promise.resolve({ conversationId })),
  updateCallSessionConversationId: jest.fn().mockResolvedValue({}),
}));

jest.mock('~/server/services/BackgroundCortexService', () => ({
  checkCortexActivation: (...args) => mockCheckVoiceEngagement(...args),
}));

jest.mock('~/models', () => ({
  getUserById: (...args) => mockGetUserById(...args),
  saveMessage: (...args) => mockSaveMessage(...args),
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
  LocalQaVoiceClassifierFaultControl: {},
}));

jest.mock('~/server/services/viventium/VoiceCortexInsightsService', () => ({
  getCompletedCortexInsightsForMessage: jest.fn(),
}));

jest.mock('~/server/services/viventium/SpeakerSegmentService', () => {
  const actual = jest.requireActual('~/server/services/viventium/SpeakerSegmentService');
  return {
    ...actual,
    listSpeakerSegments: (...args) => mockListSpeakerSegments(...args),
    persistSpeakerSegments: (...args) => mockPersistSpeakerSegments(...args),
    persistSpeakerSessionState: (...args) => mockPersistSpeakerSessionState(...args),
    projectSpeakerSegmentRevisionsToMessages: (...args) =>
      mockProjectSpeakerSegmentRevisions(...args),
  };
});

jest.mock('~/server/services/viventium/GlassHiveCallbackDeliveryService', () => ({
  claimPendingGlassHiveCallbackDeliveries: (...args) => mockClaimGlassHiveDeliveries(...args),
  markGlassHiveCallbackDeliverySent: (...args) => mockMarkGlassHiveDeliverySent(...args),
  markGlassHiveCallbackDeliveryFailed: (...args) => mockMarkGlassHiveDeliveryFailed(...args),
  markGlassHiveCallbackDeliverySuppressed: (...args) =>
    mockMarkGlassHiveDeliverySuppressed(...args),
}));

jest.mock('~/server/services/viventium/VoiceAgentAuthorizationService', () => ({
  requireVoiceAgentAccess: (...args) => mockRequireVoiceAgentAccess(...args),
}));

jest.mock('~/server/services/viventium/VoiceOrchestrationTraceService', () => ({
  currentVoiceOrchestrationTraceBinding: (...args) =>
    mockCurrentVoiceOrchestrationTraceBinding(...args),
  recordVoiceOrchestrationTrace: (...args) => mockRecordVoiceOrchestrationTrace(...args),
  recordVoiceOrchestrationTraceBestEffort: (...args) =>
    mockRecordVoiceOrchestrationTraceBestEffort(...args),
}));

jest.mock('@librechat/api', () => {
  mockActualApi ||= jest.requireActual('@librechat/api');
  return {
    ...mockActualApi,
    createMongooseVoiceClassifierFaultControlStore: jest.fn(() => ({})),
    createVoiceClassifierFaultControlManager: jest.fn(() => ({
      run: (...args) => mockRunVoiceClassifierFaultControl(...args),
    })),
    GenerationJobManager: {
      getJob: jest.fn(),
      getResumeState: jest.fn(),
      subscribe: jest.fn(),
      abortJob: jest.fn(),
    },
  };
});

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

function createVerifiedWingClassificationRequest({ turnId, text }) {
  const { assertCallSessionSecret } = require('~/server/services/viventium/CallSessionService');
  assertCallSessionSecret.mockResolvedValueOnce({
    callSessionId: 'call_session_1',
    ownerParticipantIdentity: 'owner-participant',
    userId: 'user_1',
    agentId: 'agent_voice',
    conversationId: 'conv-voice-1',
    mode: 'wing',
  });
  mockListSpeakerSegments.mockResolvedValueOnce([
    {
      version: 1,
      callSessionId: 'call_session_1',
      segmentId: `${turnId}_segment`,
      turnId,
      sequence: 1,
      revision: 1,
      text,
      isFinal: true,
      speaker: {
        key: 'participant:owner-participant',
        label: 'You',
        source: 'hybrid',
        attribution: 'verified',
        actorTrust: 'owner_participant',
        participantIdentity: 'owner-participant',
        trackSid: 'owner-track',
        providerSpeakerId: 'A',
      },
    },
  ]);

  return {
    app: createTestApp(require('../voice')),
    req: createMockReq({
      url: '/api/viventium/voice/engagement/classify',
      headers: {
        'x-viventium-call-secret': 'secret',
        'x-viventium-call-session': 'call_session_1',
        'x-viventium-call-capability': 'synthetic-browser-capability',
      },
      body: { version: 1, callSessionId: 'call_session_1', turnId },
    }),
    res: createMockRes(),
  };
}

function createSignedWingChatRequest({ turnId, text }) {
  const segmentId = `${turnId}_segment`;
  return createMockReq({
    url: '/api/viventium/voice/chat',
    headers: { 'x-viventium-call-secret': 'secret' },
    body: {
      text,
      ownerTrackSid: 'owner-track',
      voiceEngagement: {
        version: 1,
        callSessionId: 'call_session_1',
        turnId,
        participantIdentity: 'owner-participant',
        segmentIds: [segmentId],
        directlyAddressed: true,
        source: 'semantic_model',
        revision: 1,
        issuedAtMs: Date.now(),
        expiresAtMs: Date.now() + 30_000,
        attestation: 'signed-owner-engagement',
      },
      speakerSegments: [
        {
          version: 1,
          segmentId,
          turnId,
          sequence: 1,
          revision: 1,
          text,
          isFinal: true,
          speaker: {
            key: 'participant:owner-participant',
            label: 'You',
            source: 'hybrid',
            attribution: 'verified',
            actorTrust: 'owner_participant',
            participantIdentity: 'owner-participant',
            trackSid: 'owner-track',
            providerSpeakerId: 'A',
          },
        },
      ],
    },
  });
}

function createMessageFindOneMock(result = null) {
  const chain = {
    sort: jest.fn(() => chain),
    limit: jest.fn(() => chain),
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
    limit: jest.fn(() => chain),
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
    mockBackgroundActivationPolicy = null;
    mockObservedInfoLogs = [];
    mockConsoleLogSpy = jest.spyOn(console, 'log').mockImplementation((...args) => {
      mockObservedInfoLogs.push(args.map(String).join(' '));
    });
    const { logger } = require('@librechat/data-schemas');
    logger.debug.mockClear();
    logger.info.mockClear();
    logger.warn.mockClear();
    logger.error.mockClear();
    const { GenerationJobManager } = require('@librechat/api');
    const voiceTaskService = require('~/server/services/viventium/VoiceTaskService');
    voiceTaskService.resetVoiceTasksForTests();
    jest
      .spyOn(voiceTaskService, 'subscribeDurableVoiceTaskEventsForCall')
      .mockImplementation(() => ({
        ready: Promise.resolve(),
        catchUp: jest.fn().mockResolvedValue(undefined),
        seed: jest.fn(),
        stop: jest.fn(),
      }));
    GenerationJobManager.getJob.mockReset();
    GenerationJobManager.getResumeState.mockReset();
    GenerationJobManager.subscribe.mockReset();
    GenerationJobManager.abortJob.mockReset();
    GenerationJobManager.getJob.mockResolvedValue(null);
    GenerationJobManager.getResumeState.mockResolvedValue(null);
    GenerationJobManager.subscribe.mockResolvedValue(null);
    GenerationJobManager.abortJob.mockResolvedValue({ success: true });
    mockLastParentMessageId = null;
    mockLastConversationId = null;
    mockLastAgentId = null;
    mockLastRequestText = null;
    mockLastStreamId = null;
    mockLastCanAuthorizeSideEffects = null;
    mockLastActorTrust = null;
    mockLastAmbientContext = null;
    mockLastCallSessionId = null;
    mockAgentControllerCallCount = 0;
    mockAgentControllerResponseDelayMs = 0;
    mockAgentControllerGeneratedConversationId = null;
    mockRequireVoiceAgentAccess = jest.fn((_req, _res, next) => next());
    mockRecordVoiceOrchestrationTrace = jest.fn().mockResolvedValue({ accepted: true });
    mockRecordVoiceOrchestrationTraceBestEffort = jest.fn().mockResolvedValue({ accepted: true });
    mockRunVoiceClassifierFaultControl = jest.fn().mockResolvedValue({ active: false });
    mockCurrentVoiceOrchestrationTraceBinding = jest.fn().mockReturnValue({
      contractVersion: 1,
      candidateDigest: `sha256:${'1'.repeat(64)}`,
      installedArtifactDigest: `sha256:${'2'.repeat(64)}`,
      runtimeOwnerBindingHash: `sha256:${'3'.repeat(64)}`,
    });
    mockCheckVoiceEngagement = jest.fn().mockResolvedValue({
      shouldActivate: true,
      confidence: 0.97,
      reason: 'direct user engagement',
      providerAttempts: [{ provider: 'xai', model: 'grok-4.5', status: 'completed' }],
    });
    mockGetCallSessionVoiceSettings = jest.fn().mockResolvedValue({
      assistantRoute: {
        effective: { provider: 'xai', model: 'grok-4.5' },
        fallbackLlm: { provider: 'anthropic', model: 'claude-opus-5' },
      },
    });
    mockCreateVoiceEngagementAttestation = jest.fn(({ utterance: _utterance, ...value }) => ({
      version: 1,
      source: 'semantic_model',
      ...value,
      issuedAtMs: 1787659200000,
      expiresAtMs: 1787659230000,
      attestation: 'signed-owner-engagement',
    }));
    mockVerifyVoiceEngagementAttestation = jest.fn(
      (value) => value?.attestation === 'signed-owner-engagement',
    );
    mockMessageFindOne = createMessageFindOneMock(null);
    mockMessageFind = createMessageFindMock([]);
    mockMessageBulkWrite = jest.fn().mockResolvedValue({ modifiedCount: 0 });
    mockMessageFindOneAndUpdate = jest.fn().mockResolvedValue({ _id: 'listen_only_msg_oid' });
    mockSpeakerPersisted = false;
    mockSpeakerPersistedAtController = false;
    mockPersistSpeakerSegments = jest.fn().mockImplementation(async ({ currentSegments = [] }) => {
      mockSpeakerPersisted = true;
      return { accepted: [], ignored: [], effectiveSegments: currentSegments };
    });
    mockProjectSpeakerSegmentRevisions = jest.fn().mockResolvedValue({ matched: 0, updated: 0 });
    mockListSpeakerSegments = jest.fn().mockImplementation(async () => {
      const latestBySegmentId = new Map();
      const merge = (segments) => {
        for (const segment of Array.isArray(segments) ? segments : []) {
          if (!segment?.segmentId) {
            continue;
          }
          const previous = latestBySegmentId.get(segment.segmentId);
          if (!previous || Number(segment.revision || 0) >= Number(previous.revision || 0)) {
            latestBySegmentId.set(segment.segmentId, segment);
          }
        }
      };
      const previousRead = mockListSpeakerSegments.mock.results
        .slice(0, -1)
        .reverse()
        .find((result) => result.type === 'return');
      if (previousRead) {
        merge(await previousRead.value);
      }
      for (const persisted of mockPersistSpeakerSegments.mock.results) {
        if (persisted.type === 'return') {
          merge((await persisted.value)?.effectiveSegments);
        }
      }
      return [...latestBySegmentId.values()].sort(
        (left, right) =>
          Number(left.sequence || 0) - Number(right.sequence || 0) ||
          String(left.segmentId).localeCompare(String(right.segmentId)),
      );
    });
    mockPersistSpeakerSessionState = jest.fn().mockResolvedValue({
      accepted: true,
      state: {
        version: 1,
        callSessionId: 'call_session_1',
        revision: 2,
        attributionState: 'shared_mic_unverified',
        detectedAt: '2026-08-09T10:01:00.000Z',
        sourceTrackSid: 'track-owner',
      },
    });
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
      if (query.messageId && doc.messageId !== query.messageId) {
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
      ownerParticipantIdentity: 'owner-participant',
      userId: 'user_1',
      agentId: 'agent_voice',
      conversationId: 'conv-voice-1',
      listenOnlyModeEnabled: false,
    });
    mockGetCallSession = jest.fn(async () => {
      const gatewaySession = mockAssertVoiceGatewayAuth.mock.results.at(-1);
      if (gatewaySession?.type === 'return') {
        return gatewaySession.value;
      }
      const { assertCallSessionSecret } = require('~/server/services/viventium/CallSessionService');
      const browserSession = assertCallSessionSecret.mock.results.at(-1);
      return browserSession?.type === 'return'
        ? browserSession.value
        : {
            callSessionId: 'call_session_1',
            ownerParticipantIdentity: 'owner-participant',
            userId: 'user_1',
            agentId: 'agent_voice',
            conversationId: 'conv-voice-1',
            mode: 'call',
          };
    });
    mockAbandonVoiceSessionClaim = jest.fn().mockResolvedValue(true);
    mockReportVoiceSessionFailure = jest.fn().mockResolvedValue({
      callSessionId: 'call_session_1',
      status: 'failed',
      error: {
        code: 'provider_failure',
        message: 'The voice provider could not start.',
        retryable: true,
      },
    });
    mockMarkVoiceSessionReady = jest.fn().mockResolvedValue({
      callSessionId: 'call_session_1',
      mode: 'wing',
      status: 'listening',
      revision: 9,
      updatedAt: Date.parse('2026-08-09T15:10:00.000Z'),
    });
    const { assertCallSessionSecret } = require('~/server/services/viventium/CallSessionService');
    assertCallSessionSecret.mockReset();
    assertCallSessionSecret.mockResolvedValue({
      callSessionId: 'call_session_1',
      userId: 'user_1',
      agentId: 'agent_voice',
      conversationId: 'conv-voice-1',
      dispatchClaimId: 'dispatch-claim-current',
    });
    mockGetUserById = jest.fn().mockResolvedValue({ _id: 'user_1', role: 'USER' });
    mockSaveMessage = jest.fn().mockResolvedValue({});
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
    delete process.env.VIVENTIUM_VOICE_TURN_COALESCE_ENABLED;
    delete process.env.VIVENTIUM_VOICE_LIVE_TURN_COALESCE_WINDOW_MS;
    delete process.env.VIVENTIUM_VOICE_LISTEN_ONLY_TURN_COALESCE_WINDOW_MS;
    delete process.env.VIVENTIUM_VOICE_TURN_COALESCE_WAIT_MS;
    delete process.env.VIVENTIUM_VOICE_TURN_COALESCE_POLL_MS;
    delete process.env.VIVENTIUM_VOICE_TURN_COALESCE_RETURN_WINDOW_MS;
    delete process.env.VIVENTIUM_VOICE_TURN_CONTINUATION_WINDOW_MS;
    delete process.env.VIVENTIUM_VOICE_LOG_LATENCY;
  });

  test('claim returns only the canonical server-owned room, agent, identity, route, and speaker state', async () => {
    const { claimVoiceSession } = require('~/server/services/viventium/CallSessionService');
    claimVoiceSession.mockResolvedValueOnce({
      callSessionId: 'call_session_1',
      roomName: 'lc-canonical',
      gatewayAgentName: 'librechat-voice-gateway',
      ownerParticipantIdentity: 'owner-participant',
      requestedVoiceRoute: {
        stt: { provider: 'assemblyai', variant: 'universal-streaming' },
        tts: { provider: 'openai', variant: 'gpt-4o-mini-tts' },
      },
      speakerSessionState: {
        version: 1,
        callSessionId: 'call_session_1',
        revision: 3,
        attributionState: 'shared_mic_unverified',
        detectedAt: '2026-08-09T10:00:00.000Z',
      },
      activeJobId: 'job-canonical',
      activeWorkerId: 'worker-canonical',
      leaseExpiresAtMs: 123,
      mode: 'listen_only',
      status: 'connecting',
      revision: 7,
      updatedAt: new Date('2026-08-09T15:00:00.000Z').getTime(),
      error: {
        code: 'provider_failure',
        message: 'The voice provider could not start.',
        retryable: true,
      },
    });
    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const req = createMockReq({
      method: 'POST',
      url: '/api/viventium/voice/claim',
      headers: {
        'x-viventium-call-secret': 'secret',
        'x-viventium-call-session': 'call_session_1',
        'x-viventium-job-id': 'job-canonical',
        'x-viventium-worker-id': 'worker-canonical',
        'x-viventium-dispatch-claim': 'dispatch-claim-current',
      },
      body: {
        roomName: 'browser-room',
        gatewayAgentName: 'browser-agent',
        ownerParticipantIdentity: 'browser-owner',
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      status: 'claimed',
      callSessionId: 'call_session_1',
      roomName: 'lc-canonical',
      gatewayAgentName: 'librechat-voice-gateway',
      ownerParticipantIdentity: 'owner-participant',
      requestedVoiceRoute: {
        stt: { provider: 'assemblyai', variant: 'universal-streaming' },
        tts: { provider: 'openai', variant: 'gpt-4o-mini-tts' },
      },
      speakerSessionState: { attributionState: 'shared_mic_unverified', revision: 3 },
      callState: {
        version: 1,
        callSessionId: 'call_session_1',
        mode: 'listen_only',
        status: 'connecting',
        revision: 7,
        updatedAt: '2026-08-09T15:00:00.000Z',
        error: {
          code: 'provider_failure',
          message: 'The voice provider could not start.',
          retryable: true,
        },
      },
    });
    expect(JSON.stringify(res.body)).not.toContain('browser-room');
    expect(JSON.stringify(res.body)).not.toContain('browser-agent');
    expect(JSON.stringify(res.body)).not.toContain('browser-owner');
    expect(claimVoiceSession).toHaveBeenCalledWith(
      expect.objectContaining({
        callSessionId: 'call_session_1',
        jobId: 'job-canonical',
        workerId: 'worker-canonical',
        dispatchClaimId: 'dispatch-claim-current',
      }),
    );
  });

  test('claim initializes a pre-start Wing call from authoritative nested call state', async () => {
    const { claimVoiceSession } = require('~/server/services/viventium/CallSessionService');
    claimVoiceSession.mockResolvedValueOnce({
      callSessionId: 'call_session_1',
      roomName: 'lc-canonical',
      gatewayAgentName: 'librechat-voice-gateway',
      ownerParticipantIdentity: 'owner-participant',
      requestedVoiceRoute: { stt: { provider: 'assemblyai' }, tts: { provider: 'openai' } },
      activeJobId: 'job-wing',
      activeWorkerId: 'worker-wing',
      leaseExpiresAtMs: 123,
      mode: 'wing',
      status: 'created',
      revision: 4,
      updatedAt: new Date('2026-08-09T15:05:00.000Z').getTime(),
    });
    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const req = createMockReq({
      method: 'POST',
      url: '/api/viventium/voice/claim',
      headers: {
        'x-viventium-call-secret': 'secret',
        'x-viventium-call-session': 'call_session_1',
        'x-viventium-job-id': 'job-wing',
        'x-viventium-worker-id': 'worker-wing',
        'x-viventium-dispatch-claim': 'dispatch-claim-current',
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.body).toMatchObject({
      status: 'claimed',
      callState: {
        version: 1,
        callSessionId: 'call_session_1',
        mode: 'wing',
        status: 'created',
        revision: 4,
        updatedAt: '2026-08-09T15:05:00.000Z',
      },
    });
  });

  test('claim requires both bounded job and worker identities before acquiring a lease', async () => {
    const { claimVoiceSession } = require('~/server/services/viventium/CallSessionService');
    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const requests = [
      createMockReq({
        method: 'POST',
        url: '/api/viventium/voice/claim',
        headers: {
          'x-viventium-call-secret': 'secret',
          'x-viventium-call-session': 'call_session_1',
          'x-viventium-worker-id': 'worker-without-job',
        },
      }),
      createMockReq({
        method: 'POST',
        url: '/api/viventium/voice/claim',
        headers: {
          'x-viventium-call-secret': 'secret',
          'x-viventium-call-session': 'call_session_1',
          'x-viventium-job-id': 'job-without-worker',
        },
      }),
    ];

    for (const req of requests) {
      const res = createMockRes();
      await dispatch(app, req, res);
      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({
        code: 'provider_failure',
        message: 'A valid voice job and worker identity are required.',
        retryable: false,
      });
    }
    expect(claimVoiceSession).not.toHaveBeenCalled();
  });

  test('rejects a late worker whose dispatch claim was released or replaced', async () => {
    const { claimVoiceSession } = require('~/server/services/viventium/CallSessionService');
    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const req = createMockReq({
      method: 'POST',
      url: '/api/viventium/voice/claim',
      headers: {
        'x-viventium-call-secret': 'secret',
        'x-viventium-call-session': 'call_session_1',
        'x-viventium-job-id': 'job-late',
        'x-viventium-worker-id': 'worker-late',
        'x-viventium-dispatch-claim': 'dispatch-claim-stale',
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({
      code: 'auth_expired',
      message: 'The dispatch attempt is no longer authorized for this call session.',
      retryable: false,
    });
    expect(claimVoiceSession).not.toHaveBeenCalled();
  });

  test('claim reports secret failures through the public auth taxonomy only', async () => {
    const secretError = new Error('invalid secret https://example.test/?secret=never-echo');
    secretError.status = 401;
    require('~/server/services/viventium/CallSessionService').assertCallSessionSecret.mockRejectedValueOnce(
      secretError,
    );
    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const req = createMockReq({
      method: 'POST',
      url: '/api/viventium/voice/claim',
      headers: {
        'x-viventium-call-secret': 'wrong-secret',
        'x-viventium-call-session': 'call_session_1',
        'x-viventium-job-id': 'job-auth-failure',
        'x-viventium-worker-id': 'worker-auth-failure',
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({
      code: 'auth_expired',
      message: 'The call session expired or is unauthorized.',
      retryable: false,
    });
    expect(JSON.stringify(res.body)).not.toContain('never-echo');
  });

  test('abandons only the exact authenticated gateway claim with a declared startup failure', async () => {
    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const req = createMockReq({
      method: 'POST',
      url: '/api/viventium/voice/claim/abandon',
      headers: {
        'x-viventium-call-secret': 'secret',
        'x-viventium-call-session': 'call_session_1',
        'x-viventium-job-id': 'job-owner-wait',
        'x-viventium-worker-id': 'worker-owner-wait',
      },
      body: { reason: 'owner_timeout' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ version: 1, released: true });
    expect(mockAbandonVoiceSessionClaim).toHaveBeenCalledWith({
      callSessionId: 'call_session_1',
      jobId: 'job-owner-wait',
      workerId: 'worker-owner-wait',
    });
  });

  test('rejects malformed claim-abandon requests before lease mutation', async () => {
    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const requests = [
      createMockReq({
        method: 'POST',
        url: '/api/viventium/voice/claim/abandon',
        headers: {
          'x-viventium-call-secret': 'secret',
          'x-viventium-call-session': 'call_session_1',
          'x-viventium-job-id': 'job-owner-wait',
        },
        body: { reason: 'owner_timeout' },
      }),
      createMockReq({
        method: 'POST',
        url: '/api/viventium/voice/claim/abandon',
        headers: {
          'x-viventium-call-secret': 'secret',
          'x-viventium-call-session': 'call_session_1',
          'x-viventium-job-id': 'job-owner-wait',
          'x-viventium-worker-id': 'worker-owner-wait',
        },
        body: { reason: 'arbitrary_reason' },
      }),
    ];

    for (const req of requests) {
      const res = createMockRes();
      await dispatch(app, req, res);
      expect(res.statusCode).toBe(400);
    }
    expect(mockAbandonVoiceSessionClaim).not.toHaveBeenCalled();
  });

  test('reports bounded provider initialization failure through the exact gateway owner claim', async () => {
    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const req = createMockReq({
      method: 'POST',
      url: '/api/viventium/voice/call-sessions/call_session_1/failure',
      headers: {
        'x-viventium-call-secret': 'secret',
        'x-viventium-call-session': 'call_session_1',
        'x-viventium-job-id': 'job-provider',
        'x-viventium-worker-id': 'worker-provider',
      },
      body: {
        version: 1,
        classification: 'provider_failure',
        modality: 'stt',
        provider: 'assemblyai',
        phase: 'initialization',
        fatal: true,
        message: 'secret-bearing provider exception must not pass through',
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      version: 1,
      callSessionId: 'call_session_1',
      status: 'failed',
      error: {
        code: 'provider_failure',
        message: 'The voice provider could not start.',
        retryable: true,
      },
    });
    expect(JSON.stringify(res.body)).not.toContain('secret-bearing');
    expect(mockReportVoiceSessionFailure).toHaveBeenCalledWith({
      callSessionId: 'call_session_1',
      jobId: 'job-provider',
      workerId: 'worker-provider',
      classification: 'provider_failure',
      modality: 'stt',
      provider: 'assemblyai',
      phase: 'initialization',
      fatal: true,
    });
  });

  test('rejects invalid or stale gateway provider failure reports without exposing owner state', async () => {
    mockReportVoiceSessionFailure.mockResolvedValueOnce(null);
    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const req = createMockReq({
      method: 'POST',
      url: '/api/viventium/voice/call-sessions/call_session_1/failure',
      headers: {
        'x-viventium-call-secret': 'secret',
        'x-viventium-call-session': 'call_session_1',
        'x-viventium-job-id': 'job-stale',
        'x-viventium-worker-id': 'worker-stale',
      },
      body: {
        version: 1,
        classification: 'provider_failure',
        modality: 'tts',
        provider: 'openai',
        phase: 'runtime',
        fatal: true,
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({
      code: 'auth_expired',
      message: 'The gateway no longer owns this call session.',
      retryable: false,
    });
  });

  test('marks the call ready only through the exact active gateway owner', async () => {
    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const req = createMockReq({
      method: 'POST',
      url: '/api/viventium/voice/call-sessions/call_session_1/ready',
      headers: {
        'x-viventium-call-secret': 'secret',
        'x-viventium-call-session': 'call_session_1',
        'x-viventium-job-id': 'job-ready',
        'x-viventium-worker-id': 'worker-ready',
      },
      body: { version: 1 },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      version: 1,
      callSessionId: 'call_session_1',
      mode: 'wing',
      status: 'listening',
      revision: 9,
      updatedAt: '2026-08-09T15:10:00.000Z',
    });
    expect(mockMarkVoiceSessionReady).toHaveBeenCalledWith({
      callSessionId: 'call_session_1',
      jobId: 'job-ready',
      workerId: 'worker-ready',
    });
  });

  test('ready rejects malformed, stale-owner, and ended-owner attempts', async () => {
    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const malformed = createMockReq({
      method: 'POST',
      url: '/api/viventium/voice/call-sessions/call_session_1/ready',
      headers: {
        'x-viventium-call-secret': 'secret',
        'x-viventium-call-session': 'call_session_1',
        'x-viventium-job-id': 'job-ready',
      },
      body: { version: 1 },
    });
    const malformedRes = createMockRes();
    await dispatch(app, malformed, malformedRes);
    expect(malformedRes.statusCode).toBe(400);
    expect(mockMarkVoiceSessionReady).not.toHaveBeenCalled();

    mockMarkVoiceSessionReady.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    for (const workerId of ['worker-stale', 'worker-ended']) {
      const req = createMockReq({
        method: 'POST',
        url: '/api/viventium/voice/call-sessions/call_session_1/ready',
        headers: {
          'x-viventium-call-secret': 'secret',
          'x-viventium-call-session': 'call_session_1',
          'x-viventium-job-id': 'job-ready',
          'x-viventium-worker-id': workerId,
        },
        body: { version: 1 },
      });
      const res = createMockRes();
      await dispatch(app, req, res);
      expect(res.statusCode).toBe(409);
      expect(res.body).toEqual({
        code: 'auth_expired',
        message: 'The gateway no longer owns this call session.',
        retryable: false,
      });
    }
  });

  test('replays a persisted ambient segment without rewriting its existing message parent', async () => {
    const segment = {
      version: 1,
      segmentId: 'seg-ambient-replay',
      callSessionId: 'call_session_1',
      turnId: 'turn-ambient-replay',
      sequence: 2,
      revision: 1,
      text: 'Recovered soft transcript',
      isFinal: true,
      speaker: {
        key: 'track:guest',
        label: 'Guest',
        source: 'participant_track',
        attribution: 'verified',
        actorTrust: 'authenticated_participant',
        participantIdentity: 'guest-participant',
        trackSid: 'track-guest',
      },
    };
    mockPersistSpeakerSegments.mockResolvedValueOnce({
      accepted: [],
      ignored: ['seg-ambient-replay'],
      effectiveSegments: [segment],
    });
    mockMessageFindOne = createMessageFindOneMock({
      messageId: 'ambient-existing',
      parentMessageId: 'assistant-before-ambient',
    });
    mockMessageFindOneAndUpdate.mockResolvedValueOnce({
      _id: 'ambient-existing-oid',
      messageId: 'ambient-existing',
      parentMessageId: 'assistant-before-ambient',
    });
    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const req = createMockReq({
      method: 'POST',
      url: '/api/viventium/voice/ambient-transcript',
      headers: { 'x-viventium-call-secret': 'secret' },
      body: {
        version: 1,
        callSessionId: 'call_session_1',
        ingressKind: 'ambient_participant',
        segments: [segment],
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.messageIds).toHaveLength(1);
    const update = mockMessageFindOneAndUpdate.mock.calls[0][1];
    expect(update.$set).not.toHaveProperty('parentMessageId');
    expect(update.$setOnInsert.parentMessageId).toBeDefined();
  });

  test('claim fails closed with classified auth expiry after the call ended', async () => {
    const {
      assertCallSessionSecret,
      claimVoiceSession,
    } = require('~/server/services/viventium/CallSessionService');
    assertCallSessionSecret.mockResolvedValueOnce({
      callSessionId: 'call_session_1',
      status: 'ended',
    });
    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const req = createMockReq({
      method: 'POST',
      url: '/api/viventium/voice/claim',
      headers: {
        'x-viventium-call-secret': 'secret',
        'x-viventium-call-session': 'call_session_1',
        'x-viventium-job-id': 'job-after-end',
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(410);
    expect(res.body).toEqual({
      code: 'auth_expired',
      message: 'The call session has ended.',
      retryable: false,
    });
    expect(claimVoiceSession).not.toHaveBeenCalled();
  });

  test('gateway state includes the terminal canonical status', async () => {
    mockAssertVoiceGatewayAuth.mockResolvedValueOnce({
      callSessionId: 'call_session_1',
      userId: 'user_1',
      agentId: 'agent_voice',
      conversationId: 'conv-voice-1',
      mode: 'call',
      status: 'ended',
      revision: 4,
      updatedAt: Date.parse('2026-08-09T10:00:00.000Z'),
      error: {
        code: 'gateway_down',
        message: 'The voice gateway is unavailable.',
        retryable: true,
      },
    });
    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const req = createMockReq({
      method: 'GET',
      url: '/api/viventium/voice/call-sessions/call_session_1/state',
      headers: { 'x-viventium-call-secret': 'secret' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      version: 1,
      callSessionId: 'call_session_1',
      mode: 'call',
      status: 'ended',
      revision: 4,
      updatedAt: '2026-08-09T10:00:00.000Z',
      error: {
        code: 'gateway_down',
        message: 'The voice gateway is unavailable.',
        retryable: true,
      },
    });
  });

  test('persists shared-mic abstention across a worker restart before authorizing a turn', async () => {
    mockAssertVoiceGatewayAuth.mockResolvedValueOnce({
      callSessionId: 'call_session_1',
      ownerParticipantIdentity: 'owner-participant',
      userId: 'user_1',
      agentId: 'agent_voice',
      conversationId: 'conv-voice-1',
      mode: 'call',
      speakerAttributionState: 'shared_mic_unverified',
    });
    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const req = createMockReq({
      url: '/api/viventium/voice/chat',
      headers: { 'x-viventium-call-secret': 'secret' },
      body: {
        text: 'first speech after reconnect',
        ownerTrackSid: 'owner-track',
        speakerSegments: [
          {
            version: 1,
            segmentId: 'segment-after-reconnect',
            turnId: 'turn-after-reconnect',
            sequence: 1,
            revision: 0,
            text: 'first speech after reconnect',
            isFinal: true,
            speaker: {
              key: 'track:owner',
              label: 'Owner',
              source: 'hybrid',
              attribution: 'verified',
              actorTrust: 'owner_participant',
              participantIdentity: 'owner-participant',
              trackSid: 'owner-track',
            },
          },
        ],
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(mockLastCanAuthorizeSideEffects).toBe(false);
    expect(mockLastActorTrust).toBe('shared_mic_unverified');
    expect(mockPersistSpeakerSegments).toHaveBeenCalledWith(
      expect.objectContaining({ speakerAttributionState: 'shared_mic_unverified' }),
    );
  });

  test('keeps a separate signed owner track authoritative when only a guest track is shared', async () => {
    mockMessageFind = createMessageFindMock([
      {
        text: 'Delete the shared project now',
        createdAt: '2026-08-09T10:00:00.000Z',
        metadata: {
          viventium: {
            type: 'voice_ambient_transcript',
            callSessionId: 'call_session_1',
            speakerLabel: 'Guest',
            actorTrust: 'authenticated_participant',
          },
        },
      },
    ]);
    mockAssertVoiceGatewayAuth.mockResolvedValueOnce({
      callSessionId: 'call_session_1',
      ownerParticipantIdentity: 'owner-participant',
      userId: 'user_1',
      agentId: 'agent_voice',
      conversationId: 'conv-voice-1',
      mode: 'call',
      speakerAttributionState: 'shared_mic_unverified',
      sharedTrackSids: ['guest-track'],
      sharedParticipantIdentities: ['guest-participant'],
    });
    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const req = createMockReq({
      url: '/api/viventium/voice/chat',
      headers: { 'x-viventium-call-secret': 'secret' },
      body: {
        text: 'owner authorizes this action',
        ownerTrackSid: 'owner-track',
        speakerSegments: [
          {
            version: 1,
            segmentId: 'segment-owner-scoped-reconnect',
            turnId: 'turn-owner-scoped-reconnect',
            sequence: 1,
            revision: 0,
            text: 'owner authorizes this action',
            isFinal: true,
            speaker: {
              key: 'track:owner',
              label: 'Owner',
              source: 'hybrid',
              attribution: 'verified',
              actorTrust: 'owner_participant',
              participantIdentity: 'owner-participant',
              trackSid: 'owner-track',
            },
          },
        ],
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(mockLastCanAuthorizeSideEffects).toBe(true);
    expect(mockLastActorTrust).toBe('owner_participant');
    expect(mockLastAmbientContext).toEqual([
      {
        text: 'Delete the shared project now',
        speakerLabel: 'Guest',
        actorTrust: 'authenticated_participant',
        observedAt: '2026-08-09T10:00:00.000Z',
      },
    ]);
    expect(mockPersistSpeakerSegments).toHaveBeenCalledWith(
      expect.objectContaining({
        sharedTrackSids: ['guest-track'],
        sharedParticipantIdentities: ['guest-participant'],
      }),
    );
  });

  test('voice ingress schema keeps Listen-Only continuation audit fields under strict mode', async () => {
    const mongoose = require('mongoose');
    const createViventiumVoiceIngressEvent = require('../../../../db/viventiumVoiceIngressEvent');
    const connection = mongoose.createConnection();
    try {
      const VoiceIngressEvent = createViventiumVoiceIngressEvent(connection);
      const doc = new VoiceIngressEvent({
        dedupeKey: 'listen-only:call-schema:listen-only-root',
        callSessionId: 'call-schema',
        userId: 'user-schema',
        status: 'listen_only',
        messageId: 'message-schema',
        saved: true,
        expiresAt: new Date(Date.now() + 30000),
      });
      const serialized = doc.toObject();

      expect(serialized.messageId).toBe('message-schema');
      expect(serialized.saved).toBe(true);
    } finally {
      await connection.close().catch(() => {});
    }
  });

  test('does not subscribe when a voice client closes during job lookup', async () => {
    const { GenerationJobManager } = require('@librechat/api');
    let releaseJobLookup;
    let markJobLookupStarted;
    const jobLookupStarted = new Promise((resolve) => {
      markJobLookupStarted = resolve;
    });
    GenerationJobManager.getJob.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseJobLookup = resolve;
          markJobLookupStarted();
        }),
    );
    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const req = createMockReq({
      method: 'GET',
      url: '/api/viventium/voice/stream/closed-during-lookup',
    });
    const res = createMockRes();

    const dispatched = dispatch(app, req, res);
    await jobLookupStarted;
    res.emit('close');
    releaseJobLookup({ metadata: { userId: 'user_1' } });
    await new Promise((resolve) => setImmediate(resolve));

    expect(GenerationJobManager.subscribe).not.toHaveBeenCalled();
    expect(res.flushHeaders).not.toHaveBeenCalled();
    res._resolve();
    await dispatched;
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

  test('rechecks agent access before every Call/Wing turn and performs no work after revocation', async () => {
    mockRequireVoiceAgentAccess.mockImplementationOnce((request, res) => {
      expect(request.viventiumCallSession.agentId).toBe('revoked-session-agent');
      expect(request.body.agent_id).toBe('accessible-decoy-agent');
      return res.status(404).json({
        code: 'no_route',
        message: 'Voice assistant is unavailable.',
        retryable: false,
      });
    });
    mockAssertVoiceGatewayAuth.mockResolvedValueOnce({
      callSessionId: 'call_session_1',
      ownerParticipantIdentity: 'owner-participant',
      userId: 'user_1',
      agentId: 'revoked-session-agent',
      conversationId: 'conv-voice-1',
      mode: 'call',
      listenOnlyModeEnabled: false,
    });
    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const req = createMockReq({
      url: '/api/viventium/voice/chat',
      headers: { 'x-viventium-call-secret': 'secret' },
      body: {
        text: 'do not execute after revocation',
        agent_id: 'accessible-decoy-agent',
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({
      code: 'no_route',
      message: 'Voice assistant is unavailable.',
      retryable: false,
    });
    expect(mockRequireVoiceAgentAccess).toHaveBeenCalledTimes(1);
    expect(mockPersistSpeakerSegments).not.toHaveBeenCalled();
    expect(mockVoiceIngressCreate).not.toHaveBeenCalled();
    expect(mockSaveMessage).not.toHaveBeenCalled();
    expect(mockConversationFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mockAgentControllerCallCount).toBe(0);
  });

  test('persists SpeakerSegmentV1 revisions before launching and blocks side-effect authority for shared mic', async () => {
    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const speakerSegment = {
      version: 1,
      segmentId: 'seg-shared-a',
      turnId: 'turn-shared',
      sequence: 1,
      revision: 0,
      text: 'draft an email',
      isFinal: true,
      speaker: {
        key: 'provider:A',
        label: 'Speaker 1',
        source: 'provider_diarization',
        attribution: 'unverified',
        actorTrust: 'shared_mic_unverified',
        providerSpeakerId: 'A',
      },
    };
    const req = createMockReq({
      url: '/api/viventium/voice/chat',
      headers: { 'x-viventium-call-secret': 'secret' },
      body: {
        text: 'draft an email',
        speakerSegments: [speakerSegment],
        speakerSegmentRevisions: [{ ...speakerSegment, revision: 1 }],
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(mockSpeakerPersistedAtController).toBe(true);
    expect(mockPersistSpeakerSegments).toHaveBeenCalledWith(
      expect.objectContaining({
        callSessionId: 'call_session_1',
        currentSegments: expect.any(Array),
        revisions: expect.any(Array),
      }),
    );
    expect(req.body.viventiumActorTrust).toBe('shared_mic_unverified');
    expect(req.body.viventiumCanAuthorizeSideEffects).toBe(false);
    expect(req.body.viventiumDeferVoiceMemory).toBe(true);
  });

  test('accepts late speaker revisions without requiring another chat turn', async () => {
    mockPersistSpeakerSegments.mockResolvedValueOnce({
      accepted: ['seg-late'],
      ignored: [],
    });
    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const req = createMockReq({
      method: 'POST',
      url: '/api/viventium/voice/speaker-segments/revisions',
      headers: { 'x-viventium-call-secret': 'secret' },
      body: {
        speakerSegmentRevisions: [
          {
            version: 1,
            segmentId: 'seg-late',
            turnId: 'turn-previous',
            sequence: 1,
            revision: 2,
            text: 'earlier speech',
            isFinal: true,
            speaker: {
              key: 'provider:A',
              label: 'Speaker 1',
              source: 'provider_diarization',
              attribution: 'unverified',
              actorTrust: 'shared_mic_unverified',
            },
          },
        ],
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ version: 1, accepted: ['seg-late'], ignored: [] });
    expect(mockAgentControllerCallCount).toBe(0);
  });

  test('persists a call-scoped SpeakerSessionStateV1 tombstone without agent work', async () => {
    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const req = createMockReq({
      method: 'POST',
      url: '/api/viventium/voice/speaker-session-state',
      headers: { 'x-viventium-call-secret': 'secret' },
      body: {
        version: 1,
        callSessionId: 'call_session_1',
        revision: 2,
        attributionState: 'shared_mic_unverified',
        detectedAt: '2026-08-09T10:01:00.000Z',
        sourceTrackSid: 'track-owner',
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(mockPersistSpeakerSessionState).toHaveBeenCalledWith({
      callSessionId: 'call_session_1',
      state: req.body,
    });
    expect(res.body).toMatchObject({
      version: 1,
      accepted: true,
      state: { attributionState: 'shared_mic_unverified', revision: 2 },
    });
    expect(mockAgentControllerCallCount).toBe(0);
  });

  test('replays only authenticated call-scoped speaker segments after reconnect', async () => {
    mockListSpeakerSegments.mockResolvedValueOnce([
      {
        version: 1,
        segmentId: 'segment-replay',
        callSessionId: 'call_session_1',
        turnId: 'turn-replay',
        sequence: 1,
        revision: 2,
        text: 'latest caption',
        isFinal: true,
        speaker: {
          key: 'provider:A',
          label: 'Speaker 1',
          source: 'provider_diarization',
          attribution: 'unverified',
          actorTrust: 'shared_mic_unverified',
        },
      },
    ]);
    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const req = createMockReq({
      method: 'GET',
      url: '/api/viventium/voice/speaker-segments?callSessionId=call_session_1',
      headers: {
        'x-viventium-call-secret': 'secret',
        'x-viventium-call-session': 'call_session_1',
      },
      query: { callSessionId: 'call_session_1' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      version: 1,
      segments: [{ segmentId: 'segment-replay', revision: 2 }],
      hasMore: false,
    });
    expect(mockListSpeakerSegments).toHaveBeenCalledWith({
      callSessionId: 'call_session_1',
      limit: 512,
      beforeSequence: undefined,
      beforeSegmentId: undefined,
      page: true,
    });
  });

  test('never replays speaker segments from another call session', async () => {
    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const req = createMockReq({
      method: 'GET',
      url: '/api/viventium/voice/speaker-segments?callSessionId=call_other',
      headers: {
        'x-viventium-call-secret': 'secret',
        'x-viventium-call-session': 'call_session_1',
      },
      query: { callSessionId: 'call_other' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(403);
    expect(mockListSpeakerSegments).not.toHaveBeenCalled();
  });

  test('accepts the bounded browser-BFF session capability without a gateway job id', async () => {
    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const req = createMockReq({
      method: 'GET',
      url: '/api/viventium/voice/speaker-segments?callSessionId=call_session_1',
      headers: {
        'x-viventium-call-secret': 'secret',
        'x-viventium-call-session': 'call_session_1',
      },
      query: { callSessionId: 'call_session_1' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(mockAssertVoiceGatewayAuth).not.toHaveBeenCalled();
    expect(
      require('~/server/services/viventium/CallSessionService').assertCallSessionSecret,
    ).toHaveBeenCalledWith('call_session_1', 'secret');
  });

  test('rejects a mismatched browser-BFF session capability', async () => {
    const { assertCallSessionSecret } = require('~/server/services/viventium/CallSessionService');
    const authError = new Error('Unauthorized voice gateway');
    authError.status = 401;
    assertCallSessionSecret.mockRejectedValueOnce(authError);
    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const req = createMockReq({
      method: 'GET',
      url: '/api/viventium/voice/speaker-segments?callSessionId=call_session_1',
      headers: {
        'x-viventium-call-secret': 'wrong-secret',
        'x-viventium-call-session': 'call_other',
      },
      query: { callSessionId: 'call_session_1' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(401);
    expect(mockListSpeakerSegments).not.toHaveBeenCalled();
  });

  test('does not elevate the browser-BFF capability to speaker mutation routes', async () => {
    const gatewayError = new Error('Missing voice job id');
    gatewayError.status = 401;
    mockAssertVoiceGatewayAuth.mockRejectedValueOnce(gatewayError);
    const { assertCallSessionSecret } = require('~/server/services/viventium/CallSessionService');
    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const req = createMockReq({
      method: 'POST',
      url: '/api/viventium/voice/speaker-segments/revisions',
      headers: {
        'x-viventium-call-secret': 'secret',
        'x-viventium-call-session': 'call_session_1',
      },
      body: { version: 1, speakerSegmentRevisions: [] },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(401);
    expect(assertCallSessionSecret).not.toHaveBeenCalled();
    expect(mockPersistSpeakerSegments).not.toHaveBeenCalled();
  });

  test('classifies exact persisted owner speech with the configured model and Workbench Wing prompt', async () => {
    mockBackgroundActivationPolicy = {
      enabled: true,
      prompt: 'BACKGROUND_POLICY_MUST_NOT_REPLACE_WING',
    };
    const { app, req, res } = createVerifiedWingClassificationRequest({
      turnId: 'turn_owner_classify',
      text: 'Please launch the worker I requested.',
    });

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.body)).toHaveLength(11);
    expect(res.body).toMatchObject({
      callSessionId: 'call_session_1',
      turnId: 'turn_owner_classify',
      participantIdentity: 'owner-participant',
      directlyAddressed: true,
      source: 'semantic_model',
      attestation: 'signed-owner-engagement',
    });
    expect(mockCheckVoiceEngagement).toHaveBeenCalledWith(
      expect.objectContaining({
        cortexConfig: expect.objectContaining({
          activation: expect.objectContaining({
            provider: 'xai',
            model: 'grok-4.5',
            prompt: expect.stringContaining('WING MODE:'),
          }),
        }),
        req: expect.objectContaining({
          config: expect.objectContaining({
            viventium: expect.objectContaining({
              background_cortices: expect.objectContaining({
                activation_policy: { enabled: false },
                activation_subject_rule: {
                  enabled: true,
                  prompt: { promptRef: 'surface.wing' },
                },
              }),
            }),
          }),
          body: expect.objectContaining({
            viventiumCanAuthorizeSideEffects: false,
            suppressBackgroundCortices: true,
          }),
        }),
      }),
    );
    expect(mockCheckVoiceEngagement.mock.calls[0][0].cortexConfig.activation).not.toHaveProperty(
      'fallbacks',
    );
    expect(mockAgentControllerCallCount).toBe(0);
    expect(mockPersistSpeakerSegments).not.toHaveBeenCalled();
  });

  test('rejects query escape, extra body fields, and unfinished speaker evidence before classification', async () => {
    const cases = [{ query: { bypass: '1' } }, { body: { bypass: true } }, { unfinished: true }];

    for (const [index, changed] of cases.entries()) {
      const turnId = `turn_owner_rejected_${index}`;
      const { app, req, res } = createVerifiedWingClassificationRequest({
        turnId,
        text: 'Please launch the worker.',
      });
      if (changed.query) req.query = changed.query;
      if (changed.body) Object.assign(req.body, changed.body);
      if (changed.unfinished) {
        mockListSpeakerSegments.mockReset().mockResolvedValue([
          {
            version: 1,
            callSessionId: 'call_session_1',
            segmentId: `${turnId}_segment`,
            turnId,
            sequence: 1,
            revision: 1,
            text: 'Please launch the worker.',
            isFinal: false,
            speaker: {
              attribution: 'verified',
              actorTrust: 'owner_participant',
              participantIdentity: 'owner-participant',
            },
          },
        ]);
      }

      await dispatch(app, req, res);
      expect(res.statusCode).toBe(403);
      expect(res.body).toMatchObject({ code: 'voice_engagement_not_authorized' });
    }
    expect(mockCheckVoiceEngagement).not.toHaveBeenCalled();
  });

  test('does not sign when the call changes to Listen-Only during semantic classification', async () => {
    const { app, req, res } = createVerifiedWingClassificationRequest({
      turnId: 'turn_owner_model_mode_race',
      text: 'Please launch the requested worker.',
    });
    mockCheckVoiceEngagement.mockImplementationOnce(async () => {
      mockGetCallSession.mockResolvedValue({
        callSessionId: 'call_session_1',
        ownerParticipantIdentity: 'owner-participant',
        userId: 'user_1',
        agentId: 'agent_voice',
        conversationId: 'conv-voice-1',
        mode: 'listen_only',
        listenOnlyModeEnabled: true,
      });
      return {
        shouldActivate: true,
        providerAttempts: [{ provider: 'xai', model: 'grok-4.5', status: 'completed' }],
      };
    });

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ code: 'voice_engagement_not_authorized' });
    expect(mockCreateVoiceEngagementAttestation).not.toHaveBeenCalled();
  });

  test('Core verifier accepts only an exact signed current Wing receipt', async () => {
    const session = {
      callSessionId: 'call_session_1',
      ownerParticipantIdentity: 'owner-participant',
      userId: 'user_1',
      agentId: 'agent_voice',
      conversationId: 'conv-voice-1',
      mode: 'wing',
    };
    mockAssertVoiceGatewayAuth.mockResolvedValue(session);
    mockGetCallSession.mockResolvedValue(session);
    const signedRequest = createSignedWingChatRequest({
      turnId: 'turn_owner_verify',
      text: 'Please launch the requested worker.',
    });
    mockListSpeakerSegments.mockResolvedValue([
      { ...signedRequest.body.speakerSegments[0], callSessionId: 'call_session_1' },
    ]);
    const app = createTestApp(require('../voice'));
    const exact = createMockReq({
      url: '/api/viventium/voice/engagement/verify',
      headers: { 'x-viventium-call-secret': 'secret' },
      body: { version: 1, engagement: signedRequest.body.voiceEngagement },
    });
    const accepted = createMockRes();

    await dispatch(app, exact, accepted);

    expect(accepted.statusCode).toBe(200);
    expect(accepted.body).toEqual({
      version: 1,
      callSessionId: 'call_session_1',
      turnId: 'turn_owner_verify',
      verified: true,
    });

    const forged = createMockReq({
      url: '/api/viventium/voice/engagement/verify',
      headers: { 'x-viventium-call-secret': 'secret' },
      body: {
        version: 1,
        engagement: { ...signedRequest.body.voiceEngagement, attestation: 'forged' },
      },
    });
    const rejected = createMockRes();
    await dispatch(app, forged, rejected);
    expect(rejected.statusCode).toBe(403);
    expect(rejected.body).toMatchObject({ code: 'voice_engagement_not_authorized' });
  });

  test('Wing is passive without exact authority and launches once with a valid signed owner turn', async () => {
    process.env.VIVENTIUM_VOICE_TURN_COALESCE_ENABLED = 'false';
    mockAssertVoiceGatewayAuth.mockResolvedValue({
      callSessionId: 'call_session_1',
      ownerParticipantIdentity: 'owner-participant',
      userId: 'user_1',
      agentId: 'agent_voice',
      conversationId: 'conv-voice-1',
      mode: 'wing',
      wingModeEnabled: true,
    });
    const app = createTestApp(require('../voice'));
    const passive = createSignedWingChatRequest({
      turnId: 'turn_owner_passive',
      text: 'Please launch the requested worker.',
    });
    passive.body.voiceEngagement.attestation = 'forged';
    const passiveResponse = createMockRes();
    await dispatch(app, passive, passiveResponse);
    expect(passiveResponse.body).toMatchObject({ status: 'wing_passive', wingPassive: true });
    expect(mockAgentControllerCallCount).toBe(0);

    const authorized = createSignedWingChatRequest({
      turnId: 'turn_owner_authorized',
      text: 'Please launch the requested worker.',
    });
    const authorizedResponse = createMockRes();
    await dispatch(app, authorized, authorizedResponse);
    expect(authorizedResponse.statusCode).toBe(200);
    expect(mockAgentControllerCallCount).toBe(1);
    expect(mockLastCanAuthorizeSideEffects).toBe(true);
    expect(mockLastCallSessionId).toBe('call_session_1');
    expect(mockVoiceIngressCreate).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'wing_authorized', requestId: 'turn_owner_authorized' }),
    );
  });

  test('Wing rejects replay and fails closed when its one-use authority ledger is unavailable', async () => {
    process.env.VIVENTIUM_VOICE_TURN_COALESCE_ENABLED = 'false';
    mockAssertVoiceGatewayAuth.mockResolvedValue({
      callSessionId: 'call_session_1',
      ownerParticipantIdentity: 'owner-participant',
      userId: 'user_1',
      agentId: 'agent_voice',
      conversationId: 'conv-voice-1',
      mode: 'wing',
    });
    const app = createTestApp(require('../voice'));
    const request = {
      turnId: 'turn_owner_replay',
      text: 'Please launch the requested worker exactly once.',
    };
    const first = createMockRes();
    const replay = createMockRes();
    await dispatch(app, createSignedWingChatRequest(request), first);
    await dispatch(app, createSignedWingChatRequest(request), replay);
    expect(first.statusCode).toBe(200);
    expect(replay.body).toMatchObject({
      status: 'wing_passive',
      wingPassive: true,
      engagementReplayed: true,
    });
    expect(mockAgentControllerCallCount).toBe(1);

    mockVoiceIngressCreate.mockRejectedValueOnce(new Error('synthetic ledger unavailable'));
    const unavailable = createMockRes();
    await dispatch(
      app,
      createSignedWingChatRequest({
        turnId: 'turn_owner_no_ledger',
        text: 'Please launch the requested worker.',
      }),
      unavailable,
    );
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.body).toMatchObject({
      code: 'voice_engagement_unavailable',
      retryable: true,
    });
    expect(mockAgentControllerCallCount).toBe(1);
  });

  test('returns retryable gateway_down for transient speaker-session persistence failure', async () => {
    mockPersistSpeakerSessionState.mockRejectedValueOnce(new Error('synthetic database outage'));
    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const req = createMockReq({
      method: 'POST',
      url: '/api/viventium/voice/speaker-session-state',
      headers: { 'x-viventium-call-secret': 'secret' },
      body: {
        version: 1,
        callSessionId: 'call_session_1',
        revision: 2,
        attributionState: 'shared_mic_unverified',
        detectedAt: '2026-08-09T10:01:00.000Z',
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({
      code: 'gateway_down',
      message: 'Speaker state persistence is temporarily unavailable.',
      retryable: true,
    });
  });

  test('returns nonretryable provider_failure for invalid speaker-session state', async () => {
    const validationError = new Error('Invalid SpeakerSessionStateV1');
    validationError.status = 400;
    mockPersistSpeakerSessionState.mockRejectedValueOnce(validationError);
    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const req = createMockReq({
      method: 'POST',
      url: '/api/viventium/voice/speaker-session-state',
      headers: { 'x-viventium-call-secret': 'secret' },
      body: { version: 1, attributionState: 'claimed_owner' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      code: 'provider_failure',
      message: 'Invalid SpeakerSessionStateV1',
      retryable: false,
    });
  });

  test('persists authenticated ambient participant segments as soft evidence without agent work', async () => {
    mockPersistSpeakerSegments.mockResolvedValueOnce({
      accepted: ['seg-guest'],
      ignored: [],
    });
    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const req = createMockReq({
      method: 'POST',
      url: '/api/viventium/voice/ambient-transcript',
      headers: { 'x-viventium-call-secret': 'secret' },
      body: {
        version: 1,
        callSessionId: 'call_session_1',
        mode: 'call',
        ingressKind: 'ambient_participant',
        segments: [
          {
            version: 1,
            segmentId: 'seg-guest',
            callSessionId: 'call_session_1',
            turnId: 'turn-guest',
            sequence: 1,
            revision: 0,
            text: 'Guest context only',
            isFinal: true,
            speaker: {
              key: 'track:guest',
              label: 'Guest',
              source: 'hybrid',
              attribution: 'verified',
              actorTrust: 'authenticated_participant',
              participantIdentity: 'guest-participant',
              trackSid: 'track-guest',
              providerSpeakerId: 'A',
            },
          },
        ],
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      version: 1,
      accepted: ['seg-guest'],
      rejected: [],
      messageIds: [expect.stringMatching(/^ambient-/)],
    });
    expect(mockAgentControllerCallCount).toBe(0);
    expect(mockPersistSpeakerSegments).toHaveBeenCalledWith(
      expect.objectContaining({ ambientIngress: true }),
    );
    expect(mockMessageFindOneAndUpdate).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        $set: expect.objectContaining({
          _meiliIndex: false,
          memoryEligible: 'soft',
          isCreatedByUser: false,
          metadata: expect.objectContaining({
            viventium: expect.objectContaining({
              type: 'voice_ambient_transcript',
              ingressKind: 'ambient_participant',
              actorTrust: 'authenticated_participant',
              memoryEligible: 'soft',
            }),
          }),
        }),
      }),
      expect.objectContaining({ upsert: true }),
    );
  });

  test('persists the canonical owner track as soft Listen-Only evidence without agent work', async () => {
    mockAssertVoiceGatewayAuth = jest.fn().mockResolvedValue({
      callSessionId: 'call_session_listen_only',
      userId: 'user_1',
      agentId: 'agent_voice',
      conversationId: 'conv-voice-1',
      mode: 'listen_only',
      listenOnlyModeEnabled: true,
      ownerParticipantIdentity: 'owner-participant',
    });
    mockPersistSpeakerSegments.mockResolvedValueOnce({
      accepted: ['seg-listen-owner'],
      ignored: [],
    });
    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const req = createMockReq({
      method: 'POST',
      url: '/api/viventium/voice/ambient-transcript',
      headers: {
        'x-viventium-call-secret': 'secret',
        'x-viventium-job-id': 'job-listen-owner',
      },
      body: {
        version: 1,
        callSessionId: 'call_session_listen_only',
        mode: 'call',
        ingressKind: 'listen_only_owner',
        segments: [
          {
            version: 1,
            segmentId: 'seg-listen-owner',
            callSessionId: 'call_session_listen_only',
            turnId: 'turn-listen-owner',
            sequence: 1,
            revision: 0,
            text: 'Owner transcript only',
            isFinal: true,
            speaker: {
              key: 'track:owner',
              label: 'You',
              source: 'participant_track',
              attribution: 'verified',
              actorTrust: 'owner_participant',
              participantIdentity: 'owner-participant',
              trackSid: 'track-owner',
            },
          },
        ],
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      version: 1,
      accepted: ['seg-listen-owner'],
      messageIds: [expect.stringMatching(/^ambient-/)],
    });
    expect(mockAgentControllerCallCount).toBe(0);
    expect(mockPersistSpeakerSegments).toHaveBeenCalledWith(
      expect.objectContaining({
        ambientIngress: true,
        currentSegments: [
          expect.objectContaining({
            speaker: expect.objectContaining({
              attribution: 'verified',
              actorTrust: 'owner_participant',
              participantIdentity: 'owner-participant',
            }),
          }),
        ],
      }),
    );
    expect(mockMessageFindOneAndUpdate).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        $set: expect.objectContaining({
          _meiliIndex: false,
          memoryEligible: 'soft',
          isCreatedByUser: false,
          metadata: expect.objectContaining({
            viventium: expect.objectContaining({
              type: 'listen_only_transcript',
              mode: 'listen_only',
              ingressKind: 'listen_only_owner',
              ambientKind: 'listen_only_owner_track',
              actorTrust: 'owner_participant',
              memoryEligible: 'soft',
            }),
          }),
        }),
      }),
      expect.objectContaining({ upsert: true }),
    );
  });

  test('rejects Listen-Only owner ingress unless authenticated session state is Listen-Only', async () => {
    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const req = createMockReq({
      method: 'POST',
      url: '/api/viventium/voice/ambient-transcript',
      headers: { 'x-viventium-call-secret': 'secret' },
      body: {
        version: 1,
        callSessionId: 'call_session_1',
        mode: 'listen_only',
        ingressKind: 'listen_only_owner',
        segments: [
          {
            version: 1,
            segmentId: 'seg-spoofed-listen-owner',
            callSessionId: 'call_session_1',
            turnId: 'turn-spoofed-listen-owner',
            sequence: 1,
            revision: 0,
            text: 'Do not elevate this',
            isFinal: true,
            speaker: {
              key: 'track:owner',
              label: 'You',
              source: 'participant_track',
              attribution: 'verified',
              actorTrust: 'owner_participant',
              participantIdentity: 'owner-participant',
              trackSid: 'track-owner',
            },
          },
        ],
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ code: 'provider_failure', retryable: false });
    expect(mockPersistSpeakerSegments).not.toHaveBeenCalled();
    expect(mockMessageFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mockAgentControllerCallCount).toBe(0);
  });

  test('fails closed when speaker attribution is missing or rejected', async () => {
    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const req = createMockReq({
      url: '/api/viventium/voice/chat',
      headers: { 'x-viventium-call-secret': 'secret' },
      body: { text: 'send the email', speakerSegments: [{ invalid: true }] },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(req.body.speakerSegments).toEqual([]);
    expect(req.body.viventiumActorTrust).toBe('unknown');
    expect(req.body.viventiumCanAuthorizeSideEffects).toBe(false);
  });

  test('preserves a gateway-supplied per-turn streamId', async () => {
    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const req = createMockReq({
      url: '/api/viventium/voice/chat',
      headers: {
        'x-viventium-call-secret': 'secret',
        'x-viventium-request-id': 'lc_req_1',
      },
      body: { text: 'stream this turn', streamId: 'lc_req_1' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(mockLastStreamId).toBe('lc_req_1');
    expect(res.body.streamId).toBe('lc_req_1');
    expect(mockLastConversationId).toBe('conv-voice-1');
  });

  test('authors provisional voice context, ignores forged authority, and returns claimed metadata', async () => {
    mockClaimedLogicalTurn = { logical_turn_id: 'logical-voice-1', revision: 4 };
    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const req = createMockReq({
      url: '/api/viventium/voice/chat',
      headers: {
        'x-viventium-call-secret': 'secret',
        'x-viventium-request-id': 'voice-request-1',
      },
      body: {
        text: 'voice turn',
        streamId: 'voice-request-1',
        sourceEventId: 'voice:opaque:event:1',
        interactionContext: { actor_kind: 'system', origin: 'scheduler', surface: 'workbench' },
        adapterCapabilities: {
          segment_stability: 'immediate',
          supersede_scope: 'response_and_authoring',
        },
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(mockLastInteractionContext).toEqual({
      actor_kind: 'external_user',
      origin: 'interactive',
      surface: 'voice',
      conversation_id: 'conv-voice-1',
      revision: 1,
      source_event_id: 'voice:opaque:event:1',
    });
    expect(mockLastAdapterCapabilities).toEqual({
      segment_stability: 'provisional',
      supersede_scope: 'response_only',
    });
    expect(mockLastDeliveryPolicy).toEqual({ commit_authority: 'external_adapter' });
    expect(req.body).not.toHaveProperty('interactionContext');
    expect(req.body).not.toHaveProperty('adapterCapabilities');
    expect(res.body).toMatchObject({
      logical_turn_id: 'logical-voice-1',
      revision: 4,
      metadata: {
        viventium: {
          interactionContext: expect.objectContaining({
            surface: 'voice',
            logical_turn_id: 'logical-voice-1',
            revision: 4,
          }),
        },
      },
    });
  });

  test('normal voice launches with a zero live coalescing window by default', async () => {
    process.env.VIVENTIUM_VOICE_LOG_LATENCY = '1';
    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const req = createMockReq({
      url: '/api/viventium/voice/chat',
      headers: {
        'x-viventium-call-secret': 'secret',
        'x-viventium-request-id': 'lc_req_latency',
      },
      body: { text: 'launch this turn immediately', streamId: 'lc_req_latency' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(mockLastStreamId).toBe('lc_req_latency');
    expect(
      mockObservedInfoLogs.some(
        (line) =>
          line.includes('stage=voice_coalesce_done') && line.includes('coalesce_window_ms=0'),
      ),
    ).toBe(true);
    expect(
      mockObservedInfoLogs.some(
        (line) =>
          line.includes('stage=gateway_dispatch_received') &&
          line.includes('request_id=lc_req_latency'),
      ),
    ).toBe(true);
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

  test('preserves exact speaker boundaries when rapid turns from different speakers coalesce', async () => {
    jest.useFakeTimers();
    process.env.VIVENTIUM_VOICE_TURN_COALESCE_WINDOW_MS = '10';
    process.env.VIVENTIUM_VOICE_TURN_COALESCE_WAIT_MS = '200';
    process.env.VIVENTIUM_VOICE_TURN_COALESCE_POLL_MS = '5';
    process.env.VIVENTIUM_VOICE_TURN_COALESCE_RETURN_WINDOW_MS = '200';
    mockAgentControllerResponseDelayMs = 20;
    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const segment = (segmentId, sequence, label, actorTrust, text) => ({
      version: 1,
      segmentId,
      turnId: `turn-${sequence}`,
      sequence,
      revision: 0,
      text,
      isFinal: true,
      speaker: {
        key: `track:${label}`,
        label,
        source: 'participant_track',
        attribution: 'verified',
        actorTrust,
        participantIdentity: label.toLowerCase(),
        trackSid: `track-${sequence}`,
      },
    });
    const firstReq = createMockReq({
      url: '/api/viventium/voice/chat',
      headers: { 'x-viventium-call-secret': 'secret', 'x-viventium-request-id': 'speaker-1' },
      body: {
        text: 'Owner says hello',
        speakerSegments: [
          segment('seg-owner', 1, 'Owner', 'owner_participant', 'Owner says hello'),
        ],
      },
    });
    const secondReq = createMockReq({
      url: '/api/viventium/voice/chat',
      headers: { 'x-viventium-call-secret': 'secret', 'x-viventium-request-id': 'speaker-2' },
      body: {
        text: 'Guest adds context',
        speakerSegments: [
          segment('seg-guest', 2, 'Guest', 'authenticated_participant', 'Guest adds context'),
        ],
      },
    });
    const firstRes = createMockRes();
    const secondRes = createMockRes();

    const firstPromise = dispatch(app, firstReq, firstRes);
    await advanceVoiceRouteTimers(2);
    const secondPromise = dispatch(app, secondReq, secondRes);
    await advanceVoiceRouteTimers(100);
    await Promise.all([firstPromise, secondPromise]);

    expect(mockAgentControllerCallCount).toBe(1);
    expect(firstReq.body.text).toBe('Owner says hello Guest adds context');
    expect(firstReq.body.speakerSegments.map((value) => value.segmentId)).toEqual([
      'seg-owner',
      'seg-guest',
    ]);
    expect(firstReq.body.speakerLabel).toBe('multiple');
    expect(firstReq.body.viventiumCanAuthorizeSideEffects).toBe(false);
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

  test('interrupts voice speech without cancelling or persisting the underlying task', async () => {
    const { GenerationJobManager } = require('@librechat/api');
    const { createVoiceTask } = require('~/server/services/viventium/VoiceTaskService');
    createVoiceTask({
      callSessionId: 'call_session_1',
      userId: 'user_1',
      streamId: 'lc_req_abort_1',
    });
    GenerationJobManager.getJob.mockResolvedValue({
      metadata: { userId: 'user_1', viventiumCallSessionId: 'call_session_1' },
    });

    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const req = createMockReq({
      method: 'POST',
      url: '/api/viventium/voice/stream/lc_req_abort_1/abort',
      headers: { 'x-viventium-call-secret': 'secret' },
      body: { reason: 'voice_user_interruption' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      interrupted: 'lc_req_abort_1',
      taskId: expect.any(String),
    });
    expect(GenerationJobManager.abortJob).not.toHaveBeenCalled();
    expect(mockSaveMessage).not.toHaveBeenCalled();
  });

  test('reconciles durable cancellation before relaying or observing a late stream event', async () => {
    const taskService = require('~/server/services/viventium/VoiceTaskService');
    const { GenerationJobManager } = require('@librechat/api');
    const task = taskService.createVoiceTask({
      callSessionId: 'call_session_1',
      userId: 'user_1',
      conversationId: 'conv-voice-1',
      streamId: 'stream-cross-process-cancel',
    });
    taskService.setVoiceTaskSuppressionPersistenceForTests({
      persist: async () => undefined,
      clear: async () => undefined,
      lookup: async () => true,
    });
    GenerationJobManager.getJob.mockResolvedValue({ metadata: { userId: 'user_1' } });
    GenerationJobManager.subscribe.mockImplementationOnce((_streamId, onEvent, onDone) => {
      onEvent({
        event: 'on_source',
        data: { id: 'late-source', title: 'Late', url: 'https://example.test/late' },
      });
      onDone({ responseMessage: { messageId: 'late-result' } });
      return { unsubscribe: jest.fn() };
    });
    const before = taskService.snapshotEvent(task.taskId);
    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const req = createMockReq({
      method: 'GET',
      url: '/api/viventium/voice/stream/stream-cross-process-cancel',
      headers: { 'x-viventium-call-secret': 'secret' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(res.write).not.toHaveBeenCalledWith(expect.stringContaining('event: message'));
    expect(taskService.snapshotEvent(task.taskId)).toMatchObject({
      sequence: before.sequence,
      state: 'running',
    });
    expect(taskService.snapshotEvent(task.taskId).sources).toBeUndefined();
  });

  test('fails a voice stream closed when no authoritative durable task can be reconciled', async () => {
    const { GenerationJobManager } = require('@librechat/api');
    GenerationJobManager.getJob.mockResolvedValue({ metadata: { userId: 'user_1' } });
    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const req = createMockReq({
      method: 'GET',
      url: '/api/viventium/voice/stream/missing-durable-task',
      headers: { 'x-viventium-call-secret': 'secret' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({
      code: 'gateway_down',
      message: 'Voice task recovery is temporarily unavailable.',
      retryable: true,
    });
    expect(GenerationJobManager.subscribe).not.toHaveBeenCalled();
    expect(res.write).not.toHaveBeenCalled();
  });

  test('does not let one same-user call subscribe to or interrupt another call stream', async () => {
    const taskService = require('~/server/services/viventium/VoiceTaskService');
    const { GenerationJobManager } = require('@librechat/api');
    taskService.createVoiceTask({
      callSessionId: 'call_other',
      userId: 'user_1',
      streamId: 'stream-other-call',
    });
    GenerationJobManager.getJob.mockResolvedValue({ metadata: { userId: 'user_1' } });
    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);

    const streamReq = createMockReq({
      method: 'GET',
      url: '/api/viventium/voice/stream/stream-other-call',
      headers: { 'x-viventium-call-secret': 'secret' },
    });
    const streamRes = createMockRes();
    await dispatch(app, streamReq, streamRes);
    expect(streamRes.statusCode).toBe(503);
    expect(GenerationJobManager.subscribe).not.toHaveBeenCalled();
    expect(streamRes.write).not.toHaveBeenCalled();

    const abortReq = createMockReq({
      method: 'POST',
      url: '/api/viventium/voice/stream/stream-other-call/abort',
      headers: { 'x-viventium-call-secret': 'secret' },
      body: { reason: 'voice_user_interruption' },
    });
    const abortRes = createMockRes();
    await dispatch(app, abortReq, abortRes);
    expect(abortRes.statusCode).toBe(404);
    expect(abortRes.body).toMatchObject({ error: 'Stream not found' });
    expect(GenerationJobManager.abortJob).not.toHaveBeenCalled();
  });

  test('lists task snapshots through the bounded browser-BFF capability', async () => {
    const taskService = require('~/server/services/viventium/VoiceTaskService');
    const { createVoiceTask } = taskService;
    const task = createVoiceTask({
      callSessionId: 'call_session_1',
      userId: 'user_1',
      conversationId: 'conv-voice-1',
      streamId: 'stream-bff-list',
    });
    jest.spyOn(taskService, 'listDurableVoiceTaskSnapshots').mockResolvedValueOnce({
      events: [taskService.snapshotEvent(task.taskId)],
      hasMore: false,
      nextBeforeCreatedAt: null,
      nextBeforeTaskId: null,
    });
    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const req = createMockReq({
      method: 'GET',
      url: '/api/viventium/voice/tasks?callSessionId=call_session_1',
      headers: {
        'x-viventium-call-secret': 'secret',
        'x-viventium-call-session': 'call_session_1',
      },
      query: { callSessionId: 'call_session_1' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      version: 1,
      events: [{ version: 1, taskId: task.taskId, type: 'snapshot' }],
      taskOwnerCapabilityInventory: {
        authoritative: true,
        source: 'runtime_voice_task_owner_registry',
        owners: [{ kind: 'generation_job', acceptsInput: false }],
      },
    });
    expect(mockAssertVoiceGatewayAuth).not.toHaveBeenCalled();
  });

  test('streams initial and live call-scoped child task events after the parent completes', async () => {
    const taskService = require('~/server/services/viventium/VoiceTaskService');
    const { completeVoiceTask, createVoiceTask, observeGenerationEvent } = taskService;
    const parent = createVoiceTask({
      callSessionId: 'call_session_1',
      userId: 'user_1',
      conversationId: 'conv-voice-1',
      streamId: 'parent-task-stream',
    });
    completeVoiceTask(parent.taskId, { resultMessageId: 'parent-result' });
    jest.spyOn(taskService, 'listDurableVoiceTaskSnapshots').mockResolvedValueOnce({
      events: [taskService.snapshotEvent(parent.taskId)],
      hasMore: false,
      nextBeforeCreatedAt: null,
      nextBeforeTaskId: null,
    });
    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const closeHandlers = [];
    const req = createMockReq({
      method: 'GET',
      url: '/api/viventium/voice/tasks/events?callSessionId=call_session_1',
      query: { callSessionId: 'call_session_1' },
      headers: {
        'x-viventium-call-secret': 'secret',
        'x-viventium-call-session': 'call_session_1',
        'x-viventium-job-id': 'job-1',
        'x-viventium-worker-id': 'worker-1',
      },
    });
    req.on.mockImplementation((event, listener) => {
      if (event === 'close') closeHandlers.push(listener);
      return req;
    });
    const res = createMockRes();

    app.handle(req, res, (err) => {
      if (err) throw err;
    });
    await new Promise((resolve) => setImmediate(resolve));
    const child = createVoiceTask({
      callSessionId: 'call_session_1',
      userId: 'user_1',
      conversationId: 'conv-voice-1',
      streamId: 'glasshive:run-live-route',
      parentTaskId: parent.taskId,
      owner: { kind: 'glasshive_run', id: 'run-live-route' },
    });
    observeGenerationEvent(child.taskId, {
      event: 'source',
      data: {
        eventId: 'route-live-source',
        source: { title: 'Live callback source', provider: 'glasshive' },
      },
    });

    const output = res.write.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(res.headers['Content-Type']).toBe('text/event-stream');
    expect(output).toContain('event: voice_task_event');
    expect(output).toContain('event: voice_task_sync');
    expect(output).toContain(
      'data: {"version":1,"callSessionId":"call_session_1","state":"synchronized","emittedAt":',
    );
    expect(output).toContain(`"taskId":"${parent.taskId}"`);
    expect(output).toContain(`"taskId":"${child.taskId}"`);
    expect(output).toContain('Live callback source');
    expect(output).toContain('"parentTaskId"');
    const writesBeforeClose = res.write.mock.calls.length;
    closeHandlers.forEach((listener) => listener());
    observeGenerationEvent(child.taskId, {
      event: 'on_agent_update',
      data: { eventId: 'after-close', name: 'Should not stream' },
    });
    expect(res.write).toHaveBeenCalledTimes(writesBeforeClose);
  });

  test('subscribes live first and replays every durable task page beyond the in-memory limit', async () => {
    const taskService = require('~/server/services/viventium/VoiceTaskService');
    const snapshots = Array.from({ length: 1_002 }, (_, index) => ({
      version: 1,
      eventId: `snapshot-${index}`,
      sequence: 2,
      emittedAt: '2026-08-09T12:00:00.000Z',
      callSessionId: 'call_session_1',
      taskId: `durable-task-${index.toString().padStart(4, '0')}`,
      type: 'snapshot',
      state: index === 0 ? 'cancelled_unenforceable' : index === 1_001 ? 'running' : 'completed',
      cancellable: index === 1_001,
      retryable: false,
      owner: { kind: 'generation_job' },
    }));
    const listSpy = jest
      .spyOn(taskService, 'listDurableVoiceTaskSnapshots')
      .mockResolvedValueOnce({
        events: snapshots.slice(490),
        hasMore: true,
        nextBeforeCreatedAt: '2026-08-09T11:59:00.000Z',
        nextBeforeTaskId: 'durable-task-0490',
      })
      .mockResolvedValueOnce({
        events: snapshots.slice(0, 490),
        hasMore: false,
        nextBeforeCreatedAt: null,
        nextBeforeTaskId: null,
      });
    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const closeHandlers = [];
    const req = createMockReq({
      method: 'GET',
      url: '/api/viventium/voice/tasks/events?callSessionId=call_session_1',
      query: { callSessionId: 'call_session_1' },
      headers: {
        'x-viventium-call-secret': 'secret',
        'x-viventium-call-session': 'call_session_1',
        'x-viventium-job-id': 'job-1',
        'x-viventium-worker-id': 'worker-1',
      },
    });
    req.on.mockImplementation((event, listener) => {
      if (event === 'close') closeHandlers.push(listener);
      return req;
    });
    const res = createMockRes();
    app.handle(req, res, (err) => {
      if (err) throw err;
    });
    await new Promise((resolve) => setImmediate(resolve));

    const packets = res.write.mock.calls
      .map(([chunk]) => String(chunk))
      .filter((chunk) => chunk.startsWith('event: voice_task_event'));
    expect(listSpy).toHaveBeenCalledTimes(2);
    expect(packets).toHaveLength(1_002);
    expect(packets.join('')).toContain('durable-task-0000');
    expect(packets.join('')).toContain('durable-task-1001');
    const allOutput = res.write.mock.calls.map(([chunk]) => String(chunk));
    const syncPacketIndex = allOutput.findIndex((chunk) =>
      chunk.startsWith('event: voice_task_sync'),
    );
    const finalReplayIndex = allOutput.findLastIndex((chunk) =>
      chunk.startsWith('event: voice_task_event'),
    );
    expect(syncPacketIndex).toBeGreaterThan(finalReplayIndex);
    expect(allOutput[syncPacketIndex]).toMatch(
      /event: voice_task_sync\ndata: \{"version":1,"callSessionId":"call_session_1","state":"synchronized","emittedAt":"[^"\n]+"\}\n\n/,
    );
    closeHandlers.forEach((listener) => listener());
  });

  test('marks an empty durable task replay synchronized before waiting for live events', async () => {
    const taskService = require('~/server/services/viventium/VoiceTaskService');
    jest.spyOn(taskService, 'listDurableVoiceTaskSnapshots').mockResolvedValueOnce({
      events: [],
      hasMore: false,
      nextBeforeCreatedAt: null,
      nextBeforeTaskId: null,
    });
    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const closeHandlers = [];
    const req = createMockReq({
      method: 'GET',
      url: '/api/viventium/voice/tasks/events?callSessionId=call_session_1',
      query: { callSessionId: 'call_session_1' },
      headers: {
        'x-viventium-call-secret': 'secret',
        'x-viventium-call-session': 'call_session_1',
        'x-viventium-job-id': 'job-1',
        'x-viventium-worker-id': 'worker-1',
      },
    });
    req.on.mockImplementation((event, listener) => {
      if (event === 'close') closeHandlers.push(listener);
      return req;
    });
    const res = createMockRes();
    app.handle(req, res, (err) => {
      if (err) throw err;
    });
    await new Promise((resolve) => setImmediate(resolve));

    const output = res.write.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(output).not.toContain('event: voice_task_event');
    expect(output).toContain('event: voice_task_sync');
    expect(output).toContain('"state":"synchronized"');
    closeHandlers.forEach((listener) => listener());
  });

  test('flushes a remote durable catch-up event before declaring the task stream synchronized', async () => {
    const taskService = require('~/server/services/viventium/VoiceTaskService');
    const remoteEvent = {
      version: 1,
      eventId: 'remote-tail-event',
      sequence: 3,
      emittedAt: '2026-08-09T12:00:01.000Z',
      callSessionId: 'call_session_1',
      taskId: 'task-remote-tail',
      type: 'snapshot',
      state: 'running',
      phase: 'tool',
      cancellable: true,
      retryable: false,
      owner: { kind: 'glasshive_run', id: 'run-remote-tail' },
    };
    const stop = jest.fn();
    jest.spyOn(taskService, 'listDurableVoiceTaskSnapshots').mockResolvedValueOnce({
      events: [{ ...remoteEvent, eventId: 'replay-before-tail', sequence: 2 }],
      hasMore: false,
      nextBeforeCreatedAt: null,
      nextBeforeTaskId: null,
    });
    taskService.subscribeDurableVoiceTaskEventsForCall.mockImplementationOnce(({ onEvent }) => ({
      ready: Promise.resolve(),
      catchUp: jest.fn(async () => onEvent(remoteEvent)),
      seed: jest.fn(),
      stop,
    }));
    const app = createTestApp(require('../voice'));
    const closeHandlers = [];
    const req = createMockReq({
      method: 'GET',
      url: '/api/viventium/voice/tasks/events?callSessionId=call_session_1',
      query: { callSessionId: 'call_session_1' },
      headers: {
        'x-viventium-call-secret': 'secret',
        'x-viventium-call-session': 'call_session_1',
        'x-viventium-job-id': 'job-1',
        'x-viventium-worker-id': 'worker-1',
      },
    });
    req.on.mockImplementation((event, listener) => {
      if (event === 'close') closeHandlers.push(listener);
      return req;
    });
    const res = createMockRes();

    app.handle(req, res, (error) => {
      if (error) throw error;
    });
    await new Promise((resolve) => setImmediate(resolve));

    const output = res.write.mock.calls.map(([chunk]) => String(chunk));
    const remoteIndex = output.findIndex((chunk) => chunk.includes('remote-tail-event'));
    const syncIndex = output.findIndex((chunk) => chunk.startsWith('event: voice_task_sync'));
    expect(remoteIndex).toBeGreaterThanOrEqual(0);
    expect(syncIndex).toBeGreaterThan(remoteIndex);
    closeHandlers.forEach((listener) => listener());
    expect(stop).toHaveBeenCalledTimes(1);
  });

  test('fails durable task replay closed without a synchronization marker', async () => {
    const taskService = require('~/server/services/viventium/VoiceTaskService');
    jest
      .spyOn(taskService, 'listDurableVoiceTaskSnapshots')
      .mockRejectedValueOnce(
        Object.assign(new Error('database disconnected'), { code: 'db_down' }),
      );
    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const req = createMockReq({
      method: 'GET',
      url: '/api/viventium/voice/tasks/events?callSessionId=call_session_1',
      query: { callSessionId: 'call_session_1' },
      headers: {
        'x-viventium-call-secret': 'secret',
        'x-viventium-call-session': 'call_session_1',
        'x-viventium-job-id': 'job-1',
        'x-viventium-worker-id': 'worker-1',
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({
      code: 'gateway_down',
      message: 'Task history is temporarily unavailable.',
      retryable: true,
    });
    expect(res.write).not.toHaveBeenCalled();
    expect(res.headers['Content-Type']).toBeUndefined();
  });

  test('fails closed before SSE headers when the initial cross-process tail is unavailable', async () => {
    const taskService = require('~/server/services/viventium/VoiceTaskService');
    const stop = jest.fn();
    taskService.subscribeDurableVoiceTaskEventsForCall.mockReturnValueOnce({
      ready: {
        then: (_resolve, reject) => reject(new Error('tail database unavailable')),
      },
      catchUp: jest.fn(),
      seed: jest.fn(),
      stop,
    });
    const app = createTestApp(require('../voice'));
    const req = createMockReq({
      method: 'GET',
      url: '/api/viventium/voice/tasks/events?callSessionId=call_session_1',
      query: { callSessionId: 'call_session_1' },
      headers: {
        'x-viventium-call-secret': 'secret',
        'x-viventium-call-session': 'call_session_1',
        'x-viventium-job-id': 'job-1',
        'x-viventium-worker-id': 'worker-1',
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({
      code: 'gateway_down',
      message: 'Task history is temporarily unavailable.',
      retryable: true,
    });
    expect(res.write).not.toHaveBeenCalled();
    expect(res.headers['Content-Type']).toBeUndefined();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  test('never marks a repeated durable replay cursor synchronized', async () => {
    const taskService = require('~/server/services/viventium/VoiceTaskService');
    const repeatedPage = {
      events: [],
      hasMore: true,
      nextBeforeCreatedAt: '2026-08-09T11:59:00.000Z',
      nextBeforeTaskId: 'task-repeat',
    };
    jest
      .spyOn(taskService, 'listDurableVoiceTaskSnapshots')
      .mockResolvedValueOnce(repeatedPage)
      .mockResolvedValueOnce(repeatedPage);
    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const req = createMockReq({
      method: 'GET',
      url: '/api/viventium/voice/tasks/events?callSessionId=call_session_1',
      query: { callSessionId: 'call_session_1' },
      headers: {
        'x-viventium-call-secret': 'secret',
        'x-viventium-call-session': 'call_session_1',
        'x-viventium-job-id': 'job-1',
        'x-viventium-worker-id': 'worker-1',
      },
    });
    const res = createMockRes();
    app.handle(req, res, (err) => {
      if (err) throw err;
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(res.write.mock.calls.map(([chunk]) => String(chunk)).join('')).not.toContain(
      'event: voice_task_sync',
    );
    expect(res.end).toHaveBeenCalled();
  });

  test('rejects a call-scoped task stream for a different authenticated session', async () => {
    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const req = createMockReq({
      method: 'GET',
      url: '/api/viventium/voice/tasks/events?callSessionId=call_other',
      query: { callSessionId: 'call_other' },
      headers: {
        'x-viventium-call-secret': 'secret',
        'x-viventium-call-session': 'call_session_1',
        'x-viventium-job-id': 'job-1',
        'x-viventium-worker-id': 'worker-1',
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(403);
    expect(res.write).not.toHaveBeenCalled();
    expect(mockAssertVoiceGatewayAuth).toHaveBeenCalled();
  });

  test('explicit task cancellation suppresses first and confirms the owner abort', async () => {
    const { GenerationJobManager } = require('@librechat/api');
    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const chatReq = createMockReq({
      url: '/api/viventium/voice/chat',
      headers: { 'x-viventium-call-secret': 'secret' },
      body: { text: 'look up the current status', streamId: 'stream-task-cancel' },
    });
    const chatRes = createMockRes();
    await dispatch(app, chatReq, chatRes);
    expect(chatRes.body.taskId).toEqual(expect.any(String));

    GenerationJobManager.getJob.mockResolvedValueOnce({ metadata: { userId: 'user_1' } });
    GenerationJobManager.abortJob.mockResolvedValueOnce({ success: true });
    const cancelReq = createMockReq({
      method: 'POST',
      url: `/api/viventium/voice/tasks/${chatRes.body.taskId}/cancel`,
      headers: {
        'x-viventium-call-secret': 'secret',
        'x-viventium-call-session': 'call_session_1',
      },
    });
    const cancelRes = createMockRes();
    await dispatch(app, cancelReq, cancelRes);

    expect(cancelRes.statusCode).toBe(200);
    expect(cancelRes.body).toMatchObject({
      outcome: 'cancelling',
      operationId: expect.any(String),
      event: { state: 'cancelling' },
      task: {
        taskId: chatRes.body.taskId,
        state: 'cancelling',
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    const { getVoiceTask } = require('~/server/services/viventium/VoiceTaskService');
    expect(getVoiceTask(chatRes.body.taskId)).toMatchObject({
      taskId: chatRes.body.taskId,
      state: 'cancelled_confirmed',
    });
    expect(GenerationJobManager.abortJob).toHaveBeenCalledWith('stream-task-cancel');
  });

  test('returns the authoritative recovering event when the durable cancel barrier is unavailable', async () => {
    const taskService = require('~/server/services/viventium/VoiceTaskService');
    const task = taskService.createVoiceTask({
      callSessionId: 'call_session_1',
      userId: 'user_1',
      streamId: 'stream-barrier-unavailable',
    });
    taskService.setVoiceTaskSuppressionPersistenceForTests({
      persist: async () => {
        throw new Error('synthetic durable outage');
      },
      clear: async () => undefined,
      lookup: async () => false,
    });
    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const req = createMockReq({
      method: 'POST',
      url: `/api/viventium/voice/tasks/${task.taskId}/cancel`,
      headers: {
        'x-viventium-call-secret': 'secret',
        'x-viventium-call-session': 'call_session_1',
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({
      version: 1,
      code: 'gateway_down',
      retryable: true,
      event: {
        taskId: task.taskId,
        state: 'recovering',
        error: { code: 'cancel_barrier_unavailable', retryable: true },
      },
      task: { taskId: task.taskId, state: 'recovering' },
    });
  });

  test('keeps remote owner cancellation pending until its authoritative callback confirms stop', async () => {
    const { GenerationJobManager } = require('@librechat/api');
    const {
      confirmVoiceTaskOwnerCancellation,
      createVoiceTask,
      getVoiceTask,
      registerVoiceTaskOwnerAdapter,
    } = require('~/server/services/viventium/VoiceTaskService');
    const task = createVoiceTask({
      callSessionId: 'call_session_1',
      userId: 'user_1',
      conversationId: 'conv-voice-1',
      streamId: 'glasshive:run-owner-cancel',
      owner: { kind: 'glasshive_run', id: 'run-owner-cancel' },
    });
    const cancel = jest.fn().mockResolvedValue({ accepted: true });
    registerVoiceTaskOwnerAdapter(task.taskId, {
      kind: 'glasshive_run',
      cancel,
      cancellationConfirmable: true,
    });
    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const req = createMockReq({
      method: 'POST',
      url: `/api/viventium/voice/tasks/${task.taskId}/cancel`,
      headers: {
        'x-viventium-call-secret': 'secret',
        'x-viventium-call-session': 'call_session_1',
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      version: 1,
      outcome: 'cancelling',
      task: { taskId: task.taskId, state: 'cancelling' },
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(GenerationJobManager.abortJob).not.toHaveBeenCalled();
    await confirmVoiceTaskOwnerCancellation(task.taskId, 'Signed callback confirmed interruption.');
    expect(getVoiceTask(task.taskId).state).toBe('cancelled_confirmed');
  });

  test('reports remote owner cancellation as unenforceable even when the local job aborts', async () => {
    const { GenerationJobManager } = require('@librechat/api');
    const {
      createVoiceTask,
      setVoiceTaskOwnerCapabilities,
    } = require('~/server/services/viventium/VoiceTaskService');
    const task = createVoiceTask({
      callSessionId: 'call_session_1',
      userId: 'user_1',
      streamId: 'stream-remote-cancel',
    });
    setVoiceTaskOwnerCapabilities(task.taskId, {
      kind: 'remote_generation',
      cancellationConfirmable: false,
    });
    GenerationJobManager.getJob.mockResolvedValueOnce({ metadata: { userId: 'user_1' } });
    GenerationJobManager.abortJob.mockResolvedValueOnce({ success: true });
    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const req = createMockReq({
      method: 'POST',
      url: `/api/viventium/voice/tasks/${task.taskId}/cancel`,
      headers: {
        'x-viventium-call-secret': 'secret',
        'x-viventium-call-session': 'call_session_1',
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.body).toMatchObject({
      version: 1,
      outcome: 'cancelling',
      event: { state: 'cancelling' },
    });
    await new Promise((resolve) => setImmediate(resolve));
    const { getVoiceTask } = require('~/server/services/viventium/VoiceTaskService');
    expect(getVoiceTask(task.taskId)).toMatchObject({ state: 'cancelled_unenforceable' });
    expect(JSON.stringify(res.body)).not.toContain('cancellationConfirmable');
    expect(res.body.task).not.toHaveProperty('suppressed');
  });

  test('delivers task input through a real session-owned adapter and returns its authoritative event', async () => {
    const {
      createVoiceTask,
      observeGenerationEvent,
      registerVoiceTaskOwnerAdapter,
    } = require('~/server/services/viventium/VoiceTaskService');
    const task = createVoiceTask({
      callSessionId: 'call_session_1',
      userId: 'user_1',
      streamId: 'stream-input-route',
      owner: { kind: 'generation_job', id: 'stream-input-route' },
    });
    const provideInput = jest.fn().mockResolvedValue({
      accepted: true,
      phase: 'resuming',
      label: 'Continuing',
    });
    registerVoiceTaskOwnerAdapter(task.taskId, { kind: 'generation_job', provideInput });
    observeGenerationEvent(task.taskId, {
      event: 'needs_input',
      data: { id: 'route-input-needed', prompt: 'Which scope?', inputType: 'text' },
    });
    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const req = createMockReq({
      method: 'POST',
      url: `/api/viventium/voice/tasks/${task.taskId}/input`,
      headers: {
        'x-viventium-call-secret': 'secret',
        'x-viventium-call-session': 'call_session_1',
      },
      body: { input: 'Example scope' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      version: 1,
      outcome: 'accepted',
      event: { type: 'state', state: 'running', phase: 'resuming' },
      task: { taskId: task.taskId, state: 'running' },
    });
    expect(provideInput).toHaveBeenCalledWith(
      expect.objectContaining({ input: 'Example scope', operationId: expect.any(String) }),
    );
  });

  test('retries a failed task only through its installed owner adapter', async () => {
    const {
      createVoiceTask,
      failVoiceTask,
      registerVoiceTaskOwnerAdapter,
    } = require('~/server/services/viventium/VoiceTaskService');
    const task = createVoiceTask({
      callSessionId: 'call_session_1',
      userId: 'user_1',
      streamId: 'stream-retry-route',
      owner: { kind: 'generation_job', id: 'stream-retry-route' },
    });
    const retry = jest.fn().mockResolvedValue({
      accepted: true,
      streamId: 'stream-retry-route-2',
    });
    registerVoiceTaskOwnerAdapter(task.taskId, { kind: 'generation_job', retry });
    failVoiceTask(task.taskId, { code: 'provider_failure', message: 'Unavailable' });
    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const req = createMockReq({
      method: 'POST',
      url: `/api/viventium/voice/tasks/${task.taskId}/retry`,
      headers: {
        'x-viventium-call-secret': 'secret',
        'x-viventium-call-session': 'call_session_1',
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      version: 1,
      outcome: 'accepted',
      events: [
        { state: 'queued', phase: 'queued' },
        { state: 'running', phase: 'starting' },
      ],
      task: {
        taskId: expect.any(String),
        parentTaskId: task.taskId,
        state: 'running',
        streamId: 'stream-retry-route-2',
      },
      previousTask: { taskId: task.taskId, state: 'failed' },
    });
    expect(res.body.task.taskId).not.toBe(task.taskId);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  test('fails task input and retry closed when no real owner adapter is installed', async () => {
    const {
      createVoiceTask,
      failVoiceTask,
    } = require('~/server/services/viventium/VoiceTaskService');
    const task = createVoiceTask({
      callSessionId: 'call_session_1',
      userId: 'user_1',
      streamId: 'stream-no-adapter',
    });
    failVoiceTask(task.taskId, { code: 'provider_failure', message: 'Unavailable' });
    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);

    for (const operation of ['input', 'retry']) {
      const req = createMockReq({
        method: 'POST',
        url: `/api/viventium/voice/tasks/${task.taskId}/${operation}`,
        headers: {
          'x-viventium-call-secret': 'secret',
          'x-viventium-call-session': 'call_session_1',
        },
        body: operation === 'input' ? { input: 'Do not deliver this' } : {},
      });
      const res = createMockRes();
      await dispatch(app, req, res);
      expect(res.statusCode).toBe(409);
      expect(res.body).toMatchObject({
        version: 1,
        error: operation === 'input' ? 'input_unsupported' : 'retry_unsupported',
      });
    }
  });

  test('never calls an already-completed task cancelled', async () => {
    const {
      createVoiceTask,
      completeVoiceTask,
    } = require('~/server/services/viventium/VoiceTaskService');
    const task = createVoiceTask({
      callSessionId: 'call_session_1',
      userId: 'user_1',
      streamId: 'stream-completed-side-effect',
    });
    completeVoiceTask(task.taskId, { resultMessageId: 'completed-result' });
    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const req = createMockReq({
      method: 'POST',
      url: `/api/viventium/voice/tasks/${task.taskId}/cancel`,
      headers: {
        'x-viventium-call-secret': 'secret',
        'x-viventium-call-session': 'call_session_1',
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({
      version: 1,
      outcome: 'already_completed',
      task: { state: 'completed' },
    });
    expect(res.body.outcome).not.toContain('cancelled');
  });

  test.each([
    [true, 'cancelled_confirmed'],
    [false, 'cancelled_unenforceable'],
  ])('replays an already-settled cancellation idempotently (%s)', async (confirmed, state) => {
    const {
      cancelVoiceTask,
      createVoiceTask,
      settleVoiceTaskCancellation,
    } = require('~/server/services/viventium/VoiceTaskService');
    const task = createVoiceTask({
      callSessionId: 'call_session_1',
      userId: 'user_1',
      streamId: `stream-settled-${state}`,
    });
    cancelVoiceTask(task.taskId, { userId: 'user_1' });
    const terminalEvent = await settleVoiceTaskCancellation(task.taskId, { confirmed });
    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const req = createMockReq({
      method: 'POST',
      url: `/api/viventium/voice/tasks/${task.taskId}/cancel`,
      headers: {
        'x-viventium-call-secret': 'secret',
        'x-viventium-call-session': 'call_session_1',
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      version: 1,
      outcome: state,
      task: { taskId: task.taskId, state },
      event: { eventId: terminalEvent.eventId, sequence: terminalEvent.sequence, state },
    });
  });

  test('reports a failed task as inactive rather than already completed', async () => {
    const {
      createVoiceTask,
      failVoiceTask,
    } = require('~/server/services/viventium/VoiceTaskService');
    const task = createVoiceTask({
      callSessionId: 'call_session_1',
      userId: 'user_1',
      streamId: 'stream-failed-cancel',
    });
    failVoiceTask(task.taskId, { code: 'provider_failure', message: 'Unavailable' });
    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const req = createMockReq({
      method: 'POST',
      url: `/api/viventium/voice/tasks/${task.taskId}/cancel`,
      headers: {
        'x-viventium-call-secret': 'secret',
        'x-viventium-call-session': 'call_session_1',
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({
      version: 1,
      outcome: 'not_active',
      task: { taskId: task.taskId, state: 'failed' },
      event: { state: 'failed' },
    });
    expect(JSON.stringify(res.body)).not.toContain('already_completed');
  });

  test('reports an exact owner completed-before-cancel race without falling back to generation abort', async () => {
    const { GenerationJobManager } = require('@librechat/api');
    const {
      createVoiceTask,
      registerVoiceTaskOwnerAdapter,
    } = require('~/server/services/viventium/VoiceTaskService');
    const task = createVoiceTask({
      callSessionId: 'call_session_1',
      userId: 'user_1',
      streamId: 'glasshive:completed-before-cancel',
      owner: { kind: 'glasshive_run', id: 'completed-before-cancel' },
    });
    registerVoiceTaskOwnerAdapter(task.taskId, {
      kind: 'glasshive_run',
      cancel: jest.fn().mockResolvedValue({ alreadyCompleted: true }),
      cancellationConfirmable: true,
    });
    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const req = createMockReq({
      method: 'POST',
      url: `/api/viventium/voice/tasks/${task.taskId}/cancel`,
      headers: {
        'x-viventium-call-secret': 'secret',
        'x-viventium-call-session': 'call_session_1',
      },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      version: 1,
      outcome: 'cancelling',
      task: { taskId: task.taskId, state: 'cancelling' },
      event: { state: 'cancelling', phase: 'cancelling' },
    });
    const {
      flushVoiceTaskOwnerOperations,
      getVoiceTask,
    } = require('~/server/services/viventium/VoiceTaskService');
    await flushVoiceTaskOwnerOperations();
    expect(getVoiceTask(task.taskId)).toMatchObject({
      taskId: task.taskId,
      state: 'completed',
    });
    expect(GenerationJobManager.abortJob).not.toHaveBeenCalledWith(
      'glasshive:completed-before-cancel',
    );
  });

  test('detaches a passive refresh without cancelling the authoring job', async () => {
    const { GenerationJobManager } = require('@librechat/api');
    GenerationJobManager.getJob.mockResolvedValue({
      metadata: { userId: 'user_1' },
    });

    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const req = createMockReq({
      method: 'POST',
      url: '/api/viventium/voice/stream/lc_req_refresh/abort',
      headers: { 'x-viventium-call-secret': 'secret' },
      body: { reason: 'voice_client_disconnected' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(202);
    expect(res.body).toEqual({ success: true, detached: true });
    expect(GenerationJobManager.abortJob).not.toHaveBeenCalled();
    expect(mockSaveMessage).not.toHaveBeenCalled();
  });

  test('rejects an unknown voice abort reason without cancelling authoring', async () => {
    const { GenerationJobManager } = require('@librechat/api');
    GenerationJobManager.getJob.mockResolvedValue({
      metadata: { userId: 'user_1' },
    });

    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const req = createMockReq({
      method: 'POST',
      url: '/api/viventium/voice/stream/lc_req_unknown_abort/abort',
      headers: { 'x-viventium-call-secret': 'secret' },
      body: { reason: 'unexpected_transport_state' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Unsupported voice abort reason' });
    expect(GenerationJobManager.abortJob).not.toHaveBeenCalled();
    expect(mockSaveMessage).not.toHaveBeenCalled();
  });

  test('does not race a second transport abort against explicit End Call cancellation', async () => {
    const { GenerationJobManager } = require('@librechat/api');
    const abortController = new AbortController();
    abortController.abort('user_cancelled');
    GenerationJobManager.getJob.mockResolvedValue({
      metadata: { userId: 'user_1' },
      abortController,
    });

    const voiceRouter = require('../voice');
    const app = createTestApp(voiceRouter);
    const req = createMockReq({
      method: 'POST',
      url: '/api/viventium/voice/stream/lc_req_cancelled/abort',
      headers: { 'x-viventium-call-secret': 'secret' },
    });
    const res = createMockRes();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(202);
    expect(res.body).toEqual({ success: true, alreadyCancelled: true });
    expect(GenerationJobManager.abortJob).not.toHaveBeenCalled();
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
    process.env.VIVENTIUM_VOICE_TURN_CONTINUATION_WINDOW_MS = '100';
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
    expect(secondRes.body.messageId).not.toBe(firstRes.body.messageId);
  });

  test('Listen-Only mode appends resumed speech after the return window inside the continuation window', async () => {
    jest.useFakeTimers();
    process.env.VIVENTIUM_VOICE_TURN_COALESCE_WINDOW_MS = '0';
    process.env.VIVENTIUM_VOICE_TURN_COALESCE_WAIT_MS = '200';
    process.env.VIVENTIUM_VOICE_TURN_COALESCE_POLL_MS = '5';
    process.env.VIVENTIUM_VOICE_TURN_COALESCE_RETURN_WINDOW_MS = '100';
    process.env.VIVENTIUM_VOICE_TURN_CONTINUATION_WINDOW_MS = '1000';
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
        'x-viventium-request-id': 'req-listen-continue-1',
      },
      body: { text: 'first ambient turn' },
    });
    const secondReq = createMockReq({
      url: '/api/viventium/voice/chat',
      headers: {
        'x-viventium-call-secret': 'secret',
        'x-viventium-request-id': 'req-listen-continue-2',
      },
      body: { text: 'second ambient turn' },
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
    expect(mockMessageFindOneAndUpdate.mock.calls[0][1].$set.text).toBe('first ambient turn');
    expect(mockMessageFindOneAndUpdate.mock.calls[1][0].messageId).toBe(firstRes.body.messageId);
    expect(mockMessageFindOneAndUpdate.mock.calls[1][1].$set.text).toBe(
      'first ambient turn second ambient turn',
    );
    expect(secondRes.body.messageId).toBe(firstRes.body.messageId);
  });

  test('Listen-Only mode dedupes repeated continuation text after appending resumed speech', async () => {
    jest.useFakeTimers();
    process.env.VIVENTIUM_VOICE_TURN_COALESCE_WINDOW_MS = '0';
    process.env.VIVENTIUM_VOICE_TURN_COALESCE_WAIT_MS = '200';
    process.env.VIVENTIUM_VOICE_TURN_COALESCE_POLL_MS = '5';
    process.env.VIVENTIUM_VOICE_TURN_COALESCE_RETURN_WINDOW_MS = '1000';
    process.env.VIVENTIUM_VOICE_TURN_CONTINUATION_WINDOW_MS = '1000';
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
    expect(mockMessageFindOneAndUpdate.mock.calls[1][1].$set.text).toBe(
      'first ambient turn second ambient turn',
    );
    expect(secondRes.body.coalesced).toBeUndefined();
    expect(secondRes.body.messageId).toBe(firstRes.body.messageId);
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
            callbackId: 'cb-voice-1',
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
    expect(res.body.latest.callbackId).toBe('cb-voice-1');
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
