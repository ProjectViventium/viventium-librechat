const { EventEmitter } = require('events');

const mockSettleVoiceTaskGeneration = jest.fn(async () => null);
const mockDisposeClient = jest.fn();
const mockGetFiles = jest.fn(async () => []);
const mockSaveMessage = jest.fn(async () => ({}));
const mockDecrementPendingRequest = jest.fn(async () => undefined);
const mockCheckAndIncrementPendingRequest = jest.fn(async () => ({
  allowed: true,
  pendingRequests: 0,
  limit: 10,
}));
const mockEnsureMorningBriefing = jest.fn(async () => undefined);
const mockIsVoiceTaskSuppressed = jest.fn(() => false);
const mockMessageFindOneAndDelete = jest.fn();
const mockMessageExists = jest.fn(async () => false);
const mockConversationUpdateOne = jest.fn();
const mockCommitAcceptedMainTurn = jest.fn(async () => ({ status: 'committed' }));
const mockRecoverSavedNativeResponse = jest.fn();
const mockGetNativeResponse = jest.fn(async () => ({ nativeResponse: { status: 'pending' } }));
const mockRecoverNativeResponse = jest.fn(async () => true);
const mockMarkNativeReplayStored = jest.fn();
const mockEnsureAcceptedMainCompaction = jest.fn(async () => ({ status: 'empty' }));
const mockYieldAcceptedMainCompaction = jest.fn(async () => ({ status: 'idle', count: 0 }));
const mockReleaseInteractiveMainAdmissionFence = jest.fn();

const mockGenerationJobManager = {
  retainLogicalTurnInput: jest.fn(async (_user, context) => context),
  createJob: jest.fn(),
  markMainResponseComplete: jest.fn(),
  finishNativeResponse: jest.fn(),
  acknowledgeStreamDelivery: jest.fn(),
  completeJob: jest.fn(),
  emitDone: jest.fn(),
  emitChunk: jest.fn(),
  emitError: jest.fn(),
  getJob: jest.fn(),
  setContentParts: jest.fn(),
  setGraph: jest.fn(),
  updateMetadata: jest.fn(),
  getResumeState: jest.fn(),
};

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  sendEvent: jest.fn(),
  getViolationInfo: jest.fn(() => ({ score: 0 })),
  GenerationJobManager: mockGenerationJobManager,
  decrementPendingRequest: (...args) => mockDecrementPendingRequest(...args),
  sanitizeFileForTransmit: (f) => f,
  sanitizeMessageForTransmit: (m) => m,
  checkAndIncrementPendingRequest: (...args) => mockCheckAndIncrementPendingRequest(...args),
  inspectProviderDeliveryDisposition: jest.fn(() => ({ status: 'missing' })),
  resolveEffectiveDeliveryDisposition: jest.fn(() => null),
  supportsMessagingDeliveryDisposition: jest.fn(() => false),
}));

jest.mock('~/server/cleanup', () => ({
  disposeClient: (...args) => mockDisposeClient(...args),
  clientRegistry: null,
  requestDataMap: new WeakMap(),
}));

jest.mock('~/server/middleware', () => ({
  handleAbortError: jest.fn(async () => undefined),
}));

jest.mock('~/cache', () => ({
  logViolation: jest.fn(async () => undefined),
}));

jest.mock('~/models', () => ({
  getFiles: (...args) => mockGetFiles(...args),
  getNativeResponse: (...args) => mockGetNativeResponse(...args),
  saveMessage: (...args) => mockSaveMessage(...args),
}));

jest.mock('~/db/models', () => ({
  Message: {
    exists: (...args) => mockMessageExists(...args),
    updateOne: jest.fn(async () => ({matchedCount:1,modifiedCount:1})),
    findOneAndDelete: (...args) => mockMessageFindOneAndDelete(...args),
  },
  Conversation: {
    updateOne: (...args) => mockConversationUpdateOne(...args),
    collection: { updateOne: (...args) => mockConversationUpdateOne(...args) },
  },
}));

jest.mock('~/server/services/viventium/telegramTimingDeep', () => ({
  isDeepTimingEnabled: jest.fn(() => false),
  startDeepTiming: jest.fn(() => null),
  logDeepTiming: jest.fn(),
}));

jest.mock('~/server/services/viventium/morningBriefingBootstrap', () => ({
  ensureMorningBriefing: (...args) => mockEnsureMorningBriefing(...args),
}));

jest.mock('~/server/services/viventium/surfacePrompts', () => ({
  stripVoiceControlTagsForDisplay: jest.fn((text) => text),
}));

jest.mock('~/server/services/viventium/VoiceTaskService', () => ({
  isVoiceTaskSuppressed: (...args) => mockIsVoiceTaskSuppressed(...args),
  isVoiceTaskSuppressedDurably: async (...args) => mockIsVoiceTaskSuppressed(...args),
  setVoiceTaskOwnerCapabilities: jest.fn(),
  settleVoiceTaskGeneration: (...args) => mockSettleVoiceTaskGeneration(...args),
}));

jest.mock('~/server/services/viventium/nativeResponseService', () => ({
  mutateNativeResponseSources: async (_filter, operation) => operation(),
  recoverNativeResponse: (...args) => mockRecoverNativeResponse(...args),
  recoverSavedNativeResponse: (...args) => mockRecoverSavedNativeResponse(...args),
  markNativeResponseReplayStored: (...args) => mockMarkNativeReplayStored(...args),
}));

jest.mock('~/server/services/viventium/ViventiumMainContinuityService', () => ({
  commitAcceptedMainTurnFromPresentation: (...args) => mockCommitAcceptedMainTurn(...args),
}));

jest.mock('~/server/services/viventium/ViventiumMainCompactionService', () => ({
  acquireInteractiveMainAdmissionFence: jest.fn(() => mockReleaseInteractiveMainAdmissionFence),
  ensureAcceptedMainCompaction: (...args) => mockEnsureAcceptedMainCompaction(...args),
  yieldAcceptedMainCompaction: (...args) => mockYieldAcceptedMainCompaction(...args),
}));

const AgentController = require('./request');
const {
  bindLogicalTurnContext,
  createSchedulerInteractionContext,
  getTrustedInteractionContext,
  setTrustedInteractionContext,
} = require('~/server/services/viventium/interactionContext');

describe('accepted source ledger before logical claim', () => {
  test('captures the accepted text and owner-scoped files without trusting body/header source claims', async () => {
    const req = makeReq();
    req.body.messageId = 'accepted-message';
    req.body.text = '  Keep this exact request.\n';
    req.body.viventiumSourceEventId = 'spoofed-source';
    req.body.viventiumTriggeringSourceSegments = [{ text: 'spoofed text', source_event_id: 'spoofed' }];
    req.body.interactionContext = { actor_kind: 'system', origin: 'scheduler' };
    req.headers = { 'x-viventium-source-event-id': 'spoofed-header' };
    req.body.files = [
      { file_id: 'owned-file', filename: 'spoofed.txt', source_event_id: 'other-source', source_index: 9 },
      { file_id: 'foreign-file', filename: 'foreign.txt' },
    ];
    mockGetFiles.mockResolvedValueOnce([
      { file_id: 'owned-file', filename: 'owned.txt', type: 'text/plain', bytes: 12, media_group_index: 2 },
    ]);
    const context = await AgentController.__testables.captureRequestInteractionContext(req, {
      conversationId: 'conv-1', streamId: 'stream-1',
    });
    expect(mockGetFiles).toHaveBeenCalledWith(
      { user: 'user-1', file_id: { $in: ['owned-file', 'foreign-file'] } },
      undefined,
      { file_id: 1, filename: 1, type: 1, bytes: 1, media_group_index: 1 },
    );
    expect(context).toMatchObject({ actor_kind: 'external_user', origin: 'interactive', source_event_id: 'accepted-message' });
    expect(context.source_segments).toEqual([expect.objectContaining({
      ordinal: 0, source_event_id: 'accepted-message', source_index: 0,
      text: '  Keep this exact request.\n',
      source_files: [{ file_id: 'owned-file', filename: 'owned.txt', type: 'text/plain', bytes: 12, media_group_index: 2 }],
    })]);
    expect(JSON.stringify(context)).not.toContain('spoofed');
    expect(JSON.stringify(context)).not.toContain('foreign-file');
  });

  test('releases request admission when source-file lookup fails before a job exists', async () => {
    const req = makeReq();
    req.body.files = [{ file_id: 'owned-file' }];
    mockGetFiles.mockRejectedValueOnce(new Error('source lookup unavailable'));
    await expect(AgentController(req, makeRes(), jest.fn(), jest.fn(), jest.fn()))
      .rejects.toThrow('source lookup unavailable');
    expect(mockGenerationJobManager.createJob).not.toHaveBeenCalled();
    expect(mockDecrementPendingRequest).toHaveBeenCalledWith('user-1');
  });

  test('preserves trusted gateway identity and binds accepted text before claim', async () => {
    const req = makeReq();
    setTrustedInteractionContext(req, {
      actor_kind: 'external_user', origin: 'interactive', surface: 'telegram',
      conversation_id: 'conv-1', source_event_id: 'trusted-gateway-event',
    });
    req.body.source_event_id = 'spoofed-source';
    const context = await AgentController.__testables.captureRequestInteractionContext(req, {
      conversationId: 'conv-1', streamId: 'stream-1',
    });
    expect(context.source_segments).toEqual([expect.objectContaining({
      ordinal: 0, source_event_id: 'trusted-gateway-event', source_index: 0, text: 'hello',
    })]);
    expect(context.surface).toBe('telegram');
    expect(context.source_event_id).toBe('trusted-gateway-event');
  });
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeReq() {
  return {
    user: { id: 'user-1' },
    body: {
      text: 'hello',
      conversationId: 'conv-1',
      parentMessageId: '00000000-0000-0000-0000-000000000000',
      endpointOption: {
        endpoint: 'agents',
        model_parameters: { model: 'gpt-4.1' },
      },
    },
  };
}

function makeRes() {
  return {
    json: jest.fn(),
    status: jest.fn().mockReturnThis(),
    headersSent: false,
  };
}

function makeClient(phaseBPromise) {
  return {
    sender: 'Assistant',
    contentParts: [],
    options: { attachments: [] },
    skipSaveUserMessage: false,
    savedMessageIds: new Set(),
    _phaseBPromise: phaseBPromise,
    sendMessage: jest.fn(async (_text, options) => {
      options.onStart(
        {
          messageId: 'user-msg-1',
          parentMessageId: '00000000-0000-0000-0000-000000000000',
          conversationId: 'conv-1',
          text: 'hello',
        },
        'resp-msg-1',
        true,
      );
      return {
        messageId: 'resp-msg-1',
        parentMessageId: 'user-msg-1',
        conversationId: 'conv-1',
        text: 'Phase A',
        content: [{ type: 'text', text: 'Phase A' }],
        databasePromise: Promise.resolve({
          conversation: { conversationId: 'conv-1', title: 'New Chat' },
        }),
      };
    }),
  };
}

describe('ResumableAgentController Phase B stream completion window', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    delete process.env.VIVENTIUM_CORTEX_FOLLOWUP_GRACE_S;

    mockGenerationJobManager.createJob.mockResolvedValue({
      createdAt: 1,
      abortController: { signal: { aborted: false }, abort: jest.fn() },
      readyPromise: Promise.resolve(),
      emitter: new EventEmitter(),
    });
    mockGenerationJobManager.getJob.mockResolvedValue({ createdAt: 1 });
    mockGenerationJobManager.emitDone.mockResolvedValue(undefined);
    mockGenerationJobManager.completeJob.mockResolvedValue(undefined);
    mockGenerationJobManager.markMainResponseComplete.mockResolvedValue(true);
    mockGenerationJobManager.finishNativeResponse.mockResolvedValue(true);
    mockCommitAcceptedMainTurn.mockResolvedValue({ status: 'committed' });
    mockRecoverSavedNativeResponse.mockResolvedValue({
      messageId: 'resp-msg-1',
      text: 'Canonical native answer.',
    });
    mockMarkNativeReplayStored.mockResolvedValue(true);
    mockGenerationJobManager.acknowledgeStreamDelivery.mockResolvedValue({ status: 'recorded' });
    mockGenerationJobManager.emitChunk.mockResolvedValue(undefined);
    mockIsVoiceTaskSuppressed.mockReturnValue(false);
    mockGenerationJobManager.updateMetadata.mockResolvedValue(undefined);
    mockGenerationJobManager.setContentParts.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test.each(['no subscriber', 'disconnected subscriber'])('settles voice generation with %s after actual completion', async (mode) => {
    const req = makeReq();
    req.viventiumCallSession = { callSessionId: 'call-1' };
    req.body.viventiumVoiceTaskId = 'task-1';
    req.body.streamId = 'stream-1';
    const res = makeRes();
    const pending = deferred();
    const client = makeClient(Promise.resolve());
    const original = client.sendMessage.getMockImplementation();
    client.sendMessage.mockImplementation(async (...args) => { await pending.promise; return original(...args); });
    await AgentController(req, res, jest.fn(), jest.fn(async () => ({ client })), jest.fn());
    await jest.advanceTimersByTimeAsync(120);
    if (mode === 'disconnected subscriber') res.writableEnded = true;
    expect(mockSettleVoiceTaskGeneration).not.toHaveBeenCalled();
    pending.resolve();
    await jest.advanceTimersByTimeAsync(120);
    expect(mockSettleVoiceTaskGeneration).toHaveBeenCalledWith('task-1', {
      userId: 'user-1', callSessionId: 'call-1', streamId: 'stream-1',
    }, { resultMessageId: 'resp-msg-1' });
  });

  test('settles a completed superseded voice generation without reviving its presentation', async () => {
    const req = makeReq();
    req.viventiumCallSession = { callSessionId: 'call-1' };
    req.body.viventiumVoiceTaskId = 'task-1';
    req.body.streamId = 'stream-1';
    mockGenerationJobManager.getJob.mockResolvedValue({ createdAt: 1, status: 'superseded' });
    await AgentController(req, makeRes(), jest.fn(), jest.fn(async () => ({ client: makeClient(Promise.resolve()) })), jest.fn());
    await jest.advanceTimersByTimeAsync(120);
    expect(mockSettleVoiceTaskGeneration).toHaveBeenCalledWith('task-1', expect.objectContaining({ streamId: 'stream-1' }), {});
    expect(mockGenerationJobManager.emitDone).not.toHaveBeenCalled();
    expect(mockGenerationJobManager.completeJob).not.toHaveBeenCalled();
  });

  test.each(['generation', 'initialization'])('settles a real voice %s failure without a subscriber', async (stage) => {
    const req = makeReq();
    req.viventiumCallSession = { callSessionId: 'call-1' };
    req.body.viventiumVoiceTaskId = 'task-1';
    req.body.streamId = 'stream-1';
    const error = Object.assign(new Error('Provider unavailable'), { code: 'provider_unavailable' });
    const client = makeClient(Promise.resolve());
    const initialize = jest.fn(async () => ({ client }));
    if (stage === 'generation') client.sendMessage.mockRejectedValue(error);
    else initialize.mockRejectedValue(error);
    await AgentController(req, makeRes(), jest.fn(), initialize, jest.fn());
    await jest.advanceTimersByTimeAsync(120);
    expect(mockSettleVoiceTaskGeneration).toHaveBeenCalledWith('task-1', expect.objectContaining({ streamId: 'stream-1' }), { error });
  });

  test('resumable requests retain guarded assistant persistence ownership', async () => {
    const client = makeClient(Promise.resolve());
    await AgentController(makeReq(), makeRes(), jest.fn(), jest.fn(async () => ({ client })), jest.fn());
    await jest.advanceTimersByTimeAsync(120);
    expect(client.skipSaveResponseMessage).toBe(true);
    expect(mockSaveMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ messageId: 'resp-msg-1', isCreatedByUser: false }),
      expect.anything(),
    );
  });

  test.each([
    [
      'provider unavailable',
      true,
      false,
      'The model provider is temporarily overloaded. Please try again shortly.',
    ],
    ['pending without provider error', false, false, 'native_response_final_pending'],
    ['recovered final despite earlier transport error', true, true, null],
  ])(
    'preserves native recovery while reporting %s',
    async (_label, hasError, recovered, expectedError) => {
      const req = makeReq();
      req._viventiumNativeResponseIdentity = { invocationId: 'exact-native' };
      const identity = req._viventiumNativeResponseIdentity;
      const client = makeClient(Promise.resolve());
      client.admitMemoryWriter = jest.fn();
      const originalSend = client.sendMessage.getMockImplementation();
      client.sendMessage.mockImplementation(async (...args) => {
        const response = await originalSend(...args);
        if (hasError) {
          client.contentParts = [
            {
              type: 'error',
              error_class: 'provider_temporarily_unavailable',
              error: 'The model provider is temporarily overloaded. Please try again shortly.',
            },
          ];
          response.content = client.contentParts;
          response.text = '';
        }
        return response;
      });
      if (!recovered) mockRecoverSavedNativeResponse.mockResolvedValueOnce(null);
      const addTitle = jest.fn();
      await AgentController(
        req,
        makeRes(),
        jest.fn(),
        jest.fn(async () => ({ client })),
        addTitle,
      );
      await jest.advanceTimersByTimeAsync(120);
      await Promise.resolve();
      expect(req._viventiumNativeResponseIdentity).toBe(identity);
      expect(mockRecoverSavedNativeResponse).toHaveBeenCalledWith(identity, expect.any(Function));
      if (expectedError) {
        expect(mockGenerationJobManager.emitError).toHaveBeenCalledWith(
          expect.any(String),
          expectedError,
        );
        expect(mockGenerationJobManager.finishNativeResponse).not.toHaveBeenCalled();
        expect(mockMarkNativeReplayStored).not.toHaveBeenCalled();
        expect(mockGenerationJobManager.acknowledgeStreamDelivery).not.toHaveBeenCalled();
        expect(mockCommitAcceptedMainTurn).not.toHaveBeenCalled();
        expect(client.admitMemoryWriter).not.toHaveBeenCalled();
        expect(addTitle).not.toHaveBeenCalled();
      } else {
        expect(mockGenerationJobManager.emitError).not.toHaveBeenCalled();
        expect(mockGenerationJobManager.finishNativeResponse).toHaveBeenCalled();
        expect(req._viventiumNativeResponseCompleted).toBe(true);
      }
    },
  );

  test('authoritative native terminal bypasses memory, accepted continuity, and title success paths', async () => {
    const req = makeReq();
    req._viventiumNativeResponseIdentity = { invocationId: 'exact-native' };
    const client = makeClient(Promise.resolve());
    client.admitMemoryWriter = jest.fn();
    const addTitle = jest.fn();
    mockRecoverSavedNativeResponse.mockImplementationOnce(async (_identity, onTerminal) => {
      onTerminal('cancelled');
      return { messageId: 'resp-msg-1', error: true, unfinished: false, content: [{ type: 'error', error_class: 'native_response_cancelled', error: 'The response was cancelled before completion.' }] };
    });
    await AgentController(req, makeRes(), jest.fn(), jest.fn(async () => ({ client })), addTitle);
    await jest.advanceTimersByTimeAsync(120);
    await Promise.resolve();
    expect(mockRecoverNativeResponse).toHaveBeenCalledWith(req._viventiumNativeResponseIdentity);
    expect(client.admitMemoryWriter).not.toHaveBeenCalled();
    expect(mockGenerationJobManager.acknowledgeStreamDelivery).not.toHaveBeenCalled();
    expect(mockCommitAcceptedMainTurn).not.toHaveBeenCalled();
    expect(addTitle).not.toHaveBeenCalled();
    expect(req._viventiumNativeResponseCompleted).not.toBe(true);
    expect(mockDisposeClient).toHaveBeenCalledWith(client);
    expect(mockGenerationJobManager.emitError).not.toHaveBeenCalled();
  });
  test.each([
    ['committed', true],
    ['already_committed', true],
    ['qa_excluded', true],
    ['unavailable', false],
    ['context_metadata_missing', false],
    ['not_accepted', false],
    ['agent_mismatch', false],
    ['invalid', false],
  ])(
    'live native final only releases replay when projection %s is complete',
    async (status, complete) => {
      const req = makeReq();
      req._viventiumNativeResponseIdentity = {
        streamId: 'conv-1',
        responseMessageId: 'resp-msg-1',
      };
      mockCommitAcceptedMainTurn.mockResolvedValue({ status });
      const client = makeClient(Promise.resolve());
      await AgentController(
        req,
        makeRes(),
        jest.fn(),
        jest.fn(async () => ({ client })),
        jest.fn(),
      );
      await jest.advanceTimersByTimeAsync(120);
      expect(mockCommitAcceptedMainTurn).toHaveBeenCalled();
      if (complete) {
        expect(mockMarkNativeReplayStored).toHaveBeenCalledWith(
          req._viventiumNativeResponseIdentity,
        );
      } else {
        expect(mockMarkNativeReplayStored).not.toHaveBeenCalled();
        expect(mockGenerationJobManager.emitError).toHaveBeenCalledWith(
          'conv-1',
          'native_response_presentation_pending',
        );
      }
    },
  );

  test('live native final reports a pending replay mark without declaring it stored', async () => {
    const req = makeReq();
    req._viventiumNativeResponseIdentity = { streamId: 'conv-1', responseMessageId: 'resp-msg-1' };
    mockMarkNativeReplayStored.mockResolvedValue(false);
    const client = makeClient(Promise.resolve());
    await AgentController(
      req,
      makeRes(),
      jest.fn(),
      jest.fn(async () => ({ client })),
      jest.fn(),
    );
    await jest.advanceTimersByTimeAsync(120);
    expect(mockMarkNativeReplayStored).toHaveBeenCalled();
    expect(mockGenerationJobManager.emitError).toHaveBeenCalledWith(
      'conv-1',
      'native_response_replay_pending',
    );
  });

  test('authors a web InteractionContext and does not trust privileged request fields', async () => {
    const req = makeReq();
    req.body.messageId = 'web-source-event-1';
    req.body.interactionContext = {
      actor_kind: 'system',
      origin: 'scheduler',
      surface: 'workbench',
      segment_stability: 'immediate',
      supersede_scope: 'response_only',
    };
    const client = makeClient(Promise.resolve());

    await AgentController(
      req,
      makeRes(),
      jest.fn(),
      jest.fn(async () => ({ client })),
      jest.fn(),
    );

    expect(mockGenerationJobManager.createJob).toHaveBeenCalledWith('conv-1', 'user-1', 'conv-1', {
      adapterCapabilities: {
        segment_stability: 'immediate',
        supersede_scope: 'response_and_authoring',
      },
      interactionContext: {
        actor_kind: 'external_user',
        origin: 'interactive',
        surface: 'web',
        conversation_id: 'conv-1',
        revision: 1,
        source_event_id: 'web-source-event-1',
        source_segments: [expect.objectContaining({ ordinal: 0, source_event_id: 'web-source-event-1', source_index: 0, text: 'hello' })],
      },
      deliveryPolicy: { commit_authority: 'server' },
    });
  });

  test('attaches trusted internal provenance to persisted rows', async () => {
    const req = makeReq();
    setTrustedInteractionContext(
      req,
      createSchedulerInteractionContext({
        conversation_id: 'conv-1',
        source_event_id: 'scheduled-run-9',
      }),
      { segment_stability: 'immediate', supersede_scope: 'response_only' },
      { commit_authority: 'server' },
    );

    await AgentController.__testables.timedSaveMessage(
      req,
      { messageId: 'scheduled-message-9', metadata: { existing: true } },
      { context: 'interaction-context-test' },
      'db_save_test',
    );

    expect(mockSaveMessage).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        metadata: {
          existing: true,
          viventium: {
            adapterCapabilities: {
              segment_stability: 'immediate',
              supersede_scope: 'response_only',
            },
            deliveryPolicy: { commit_authority: 'server' },
            memoryEligible: false,
            recallEligible: true,
            interactionContext: {
              actor_kind: 'system',
              origin: 'scheduler',
              surface: 'workbench',
              conversation_id: 'conv-1',
              revision: 1,
              source_event_id: 'scheduled-run-9',
            },
          },
        },
      }),
      { context: 'interaction-context-test', operationKind: 'system' },
    );
  });

  test('does not persist an assistant revision after it is superseded', async () => {
    const req = makeReq();
    req._resumableStreamId = 'stream-old';
    setTrustedInteractionContext(
      req,
      createSchedulerInteractionContext({
        conversation_id: 'conv-1',
        source_event_id: 'scheduled-old',
      }),
      { segment_stability: 'immediate', supersede_scope: 'response_only' },
      { commit_authority: 'server' },
    );
    bindLogicalTurnContext(req, {
      ...require('~/server/services/viventium/interactionContext').getTrustedInteractionContext(
        req,
      ),
      logical_turn_id: 'logical-old',
      revision: 1,
    });
    mockGenerationJobManager.getJob.mockResolvedValue({ status: 'superseded' });

    const result = await AgentController.__testables.timedSaveMessage(
      req,
      {
        messageId: 'assistant-old',
        conversationId: 'conv-1',
        isCreatedByUser: false,
        text: 'unfinished',
      },
      { context: 'superseded-test' },
      'db_save_test',
    );

    expect(result).toEqual({ suppressed: true, reason: 'superseded' });
    expect(mockSaveMessage).not.toHaveBeenCalled();
    expect(mockMessageFindOneAndDelete).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'assistant-old', isCreatedByUser: { $ne: true } }),
    );
  });

  test('keeps scheduler-only silence archived and unarchives the first deliverable result', async () => {
    const req = makeReq();
    setTrustedInteractionContext(
      req,
      createSchedulerInteractionContext({
        conversation_id: 'conv-1',
        source_event_id: 'scheduled-archive',
      }),
      { segment_stability: 'immediate', supersede_scope: 'response_only' },
      { commit_authority: 'server' },
    );

    await AgentController.__testables.timedSaveMessage(
      req,
      {
        messageId: 'assistant-nta',
        conversationId: 'conv-1',
        isCreatedByUser: false,
        text: '{NTA}',
      },
      {},
      'nta',
    );
    expect(mockConversationUpdateOne).toHaveBeenLastCalledWith(
      expect.objectContaining({ conversationId: 'conv-1' }),
      { $set: { isArchived: true } },
    );
    expect(mockMessageExists).toHaveBeenCalledWith({
      user: 'user-1',
      conversationId: 'conv-1',
      isCreatedByUser: { $ne: true },
      unfinished: { $ne: true },
      'metadata.viventium.visibility': { $ne: 'internal' },
    });

    await AgentController.__testables.timedSaveMessage(
      req,
      {
        messageId: 'assistant-visible',
        conversationId: 'conv-1',
        isCreatedByUser: false,
        text: 'A useful scheduled result',
      },
      {},
      'visible',
    );
    expect(mockConversationUpdateOne).toHaveBeenLastCalledWith(
      expect.objectContaining({ conversationId: 'conv-1' }),
      { $set: { isArchived: false } },
    );

    mockMessageExists.mockResolvedValueOnce({ _id: 'earlier-visible-assistant' });
    mockConversationUpdateOne.mockClear();
    await AgentController.__testables.timedSaveMessage(
      req,
      {
        messageId: 'assistant-later-nta',
        conversationId: 'conv-1',
        isCreatedByUser: false,
        text: '{NTA}',
      },
      {},
      'later-nta',
    );
    expect(mockConversationUpdateOne).not.toHaveBeenCalled();
  });

  test('waits for client._phaseBPromise before completeJob', async () => {
    const phaseB = deferred();
    const client = makeClient(phaseB.promise);
    const initializeClient = jest.fn(async () => ({ client }));
    const addTitle = jest.fn();

    await AgentController(makeReq(), makeRes(), jest.fn(), initializeClient, addTitle);
    await jest.advanceTimersByTimeAsync(120);
    await Promise.resolve();

    expect(mockGenerationJobManager.emitDone).toHaveBeenCalled();
    expect(mockGenerationJobManager.markMainResponseComplete).toHaveBeenCalledWith(
      'conv-1',
      expect.objectContaining({ final: true }),
    );
    expect(
      mockGenerationJobManager.markMainResponseComplete.mock.invocationCallOrder[0],
    ).toBeLessThan(mockGenerationJobManager.emitDone.mock.invocationCallOrder[0]);
    expect(mockGenerationJobManager.acknowledgeStreamDelivery).toHaveBeenCalledWith('conv-1', {
      state: 'committed',
      presentation_ref: 'resp-msg-1',
    });
    expect(mockGenerationJobManager.emitDone.mock.invocationCallOrder[0]).toBeLessThan(
      mockGenerationJobManager.acknowledgeStreamDelivery.mock.invocationCallOrder[0],
    );
    expect(mockGenerationJobManager.completeJob).not.toHaveBeenCalled();

    phaseB.resolve();
    await jest.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(mockGenerationJobManager.completeJob).toHaveBeenCalledWith('conv-1');
  });

  test('includes a failed memory admission in the final visible response and shared receipt', async () => {
    const req = makeReq();
    const client = makeClient(Promise.resolve());
    const receipt = {
      type: 'memory',
      memory: {
        type: 'error',
        key: 'system',
        value: JSON.stringify({ errorType: 'writer_unavailable', partialApplied: false }),
      },
    };
    client.admitMemoryWriter = jest.fn(async () => {
      req._viventiumMemoryAdmissionReceipt = receipt;
      return false;
    });
    await AgentController(
      req,
      makeRes(),
      jest.fn(),
      jest.fn(async () => ({ client })),
      jest.fn(),
    );
    await jest.advanceTimersByTimeAsync(120);
    await Promise.resolve();
    expect(mockGenerationJobManager.emitDone).toHaveBeenCalledWith(
      'conv-1',
      expect.objectContaining({
        memoryWriterScheduled: false,
        memoryReceipt: {
          status: 'failed',
          keys: [],
          errorType: 'writer_unavailable',
          failures: [{ errorType: 'writer_unavailable', partialApplied: false }],
        },
        responseMessage: expect.objectContaining({
          attachments: expect.arrayContaining([receipt]),
        }),
      }),
    );
  });

  test('persists the user source segment before superseded generation can exit', async () => {
    const req = makeReq();
    const abortSignal = { aborted: false, reason: undefined };
    mockGenerationJobManager.createJob.mockResolvedValueOnce({
      createdAt: 1,
      abortController: { signal: abortSignal, abort: jest.fn() },
      readyPromise: Promise.resolve(),
      emitter: new EventEmitter(),
    });
    const client = makeClient(Promise.resolve());
    client.sendMessage.mockImplementationOnce(async (_text, options) => {
      await options.onStart(
        {
          messageId: 'user-msg-a',
          parentMessageId: '00000000-0000-0000-0000-000000000000',
          conversationId: 'conv-1',
          text: 'A',
          isCreatedByUser: true,
        },
        'response-b',
        true,
      );
      abortSignal.aborted = true;
      abortSignal.reason = 'superseded';
      throw new Error('aborted by supersession');
    });

    await AgentController(
      req,
      makeRes(),
      jest.fn(),
      jest.fn(async () => ({ client })),
      jest.fn(),
    );
    await jest.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(mockSaveMessage).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        messageId: 'user-msg-a',
        text: 'A',
        isCreatedByUser: true,
      }),
      expect.objectContaining({
        context: expect.stringContaining('user source segment'),
      }),
    );
  });

  test('initial root placeholder alone carries the exact captured Main write binding', async () => {
    const req = makeReq();
    const identity = Object.freeze({
      ownerId: req.user.id,
      agentId: 'agent',
      stableAuthoritySha256: 'a'.repeat(64),
    });
    Object.defineProperty(req, '_viventiumAcceptedMainCompactionIdentityV1', { value: identity });
    const client = makeClient(Promise.resolve());
    const send = client.sendMessage.getMockImplementation();
    client.sendMessage.mockImplementationOnce(async (text, options) => {
      const onStart = options.onStart;
      let started;
      const result = await send(text, {
        ...options,
        onStart: (...args) => {
          started = onStart(...args);
        },
      });
      await started;
      const initial = mockSaveMessage.mock.calls.find(
        ([, message]) => message.messageId === 'resp-msg-1',
      );
      expect(initial[2].mainContextBinding).toEqual({ responseMessageId: 'resp-msg-1', identity });
      expect(initial[2].mainContextBinding.identity).toBe(identity);
      return result;
    });
    await AgentController(
      req,
      makeRes(),
      jest.fn(),
      jest.fn(async () => ({ client })),
      jest.fn(),
    );
    await jest.advanceTimersByTimeAsync(120);
    await Promise.resolve();
    const boundWrites = mockSaveMessage.mock.calls.filter(
      ([, , options]) => options.mainContextBinding,
    );
    expect(boundWrites).toHaveLength(1);
    expect(boundWrites[0][1]).toMatchObject({
      messageId: 'resp-msg-1',
      isCreatedByUser: false,
      unfinished: true,
    });
  });

  test.each([true, false])(
    'Main compaction keeps the existing voice side-effect gate (owner=%s)',
    async (owner) => {
      const req = makeReq();
      req.body.voiceMode = true;
      req.body.viventiumActorTrust = owner ? 'owner_participant' : 'unknown';
      req.body.viventiumCanAuthorizeSideEffects = owner;
      const identity = Object.freeze({
        ownerId: req.user.id,
        agentId: 'agent',
        stableAuthoritySha256: 'a'.repeat(64),
      });
      Object.defineProperty(req, '_viventiumAcceptedMainCompactionIdentityV1', { value: identity });
      const client = makeClient(Promise.resolve());
      client.options.agent = { id: 'runtime-fallback-agent' };
      await AgentController(
        req,
        makeRes(),
        jest.fn(),
        jest.fn(async () => ({ client })),
        jest.fn(),
      );
      await jest.advanceTimersByTimeAsync(120);
      await Promise.resolve();
      expect(mockEnsureAcceptedMainCompaction).toHaveBeenCalledTimes(owner ? 1 : 0);
      if (owner)
        expect(mockEnsureAcceptedMainCompaction).toHaveBeenCalledWith(
          expect.objectContaining(identity),
        );
    },
  );

  test('durably removes an unfinished older assistant revision when the next revision starts', async () => {
    const persistedRows = [
      {
        _id: 'user-a-mongo-id',
        messageId: 'user-a',
        isCreatedByUser: true,
      },
      {
        _id: 'old-assistant-mongo-id',
        messageId: 'response-b',
        isCreatedByUser: false,
        unfinished: true,
        logical_turn_id: 'logical-a-c',
        revision: 1,
      },
    ];
    mockMessageFindOneAndDelete.mockImplementationOnce(async (query) => {
      const index = persistedRows.findIndex(
        (row) =>
          row.messageId === query.messageId &&
          row.isCreatedByUser !== true &&
          row.unfinished === query.unfinished &&
          row.logical_turn_id === query['metadata.viventium.interactionContext.logical_turn_id'] &&
          row.revision === query['metadata.viventium.interactionContext.revision'],
      );
      return index >= 0 ? persistedRows.splice(index, 1)[0] : null;
    });
    mockGenerationJobManager.createJob.mockResolvedValueOnce({
      createdAt: 2,
      abortController: { signal: { aborted: false }, abort: jest.fn() },
      readyPromise: Promise.resolve(),
      emitter: new EventEmitter(),
      supersededPresentations: [
        {
          conversationId: 'conv-1',
          responseMessageId: 'response-b',
          interactionContext: {
            logical_turn_id: 'logical-a-c',
            revision: 1,
          },
        },
      ],
    });
    mockGenerationJobManager.getJob.mockResolvedValue({ createdAt: 2 });

    await AgentController(
      makeReq(),
      makeRes(),
      jest.fn(),
      jest.fn(async () => ({ client: makeClient(Promise.resolve()) })),
      jest.fn(),
    );

    expect(mockMessageFindOneAndDelete).toHaveBeenCalledWith({
      user: 'user-1',
      messageId: 'response-b',
      isCreatedByUser: { $ne: true },
      unfinished: true,
      'metadata.viventium.interactionContext.logical_turn_id': 'logical-a-c',
      'metadata.viventium.interactionContext.revision': 1,
    });
    expect(mockConversationUpdateOne).toHaveBeenCalledWith(
      { user: 'user-1', conversationId: 'conv-1' },
      { $pull: { messages: 'old-assistant-mongo-id' } },
    );
    // A refresh/reload cannot resurrect unfinished B, while user-authored A remains durable.
    expect(persistedRows).toEqual([
      expect.objectContaining({ messageId: 'user-a', isCreatedByUser: true }),
    ]);
  });

  test.each(['matching', 'other-conversation', 'other-turn', 'not-older', 'missing-user'])('retracting a response preserves only its proven incoming user chain: %s', async (change) => {
    const req = makeReq();
    req.body.parentMessageId = 'response-b';
    setTrustedInteractionContext(req, {
      actor_kind: 'external_user', origin: 'interactive', surface: 'telegram',
      conversation_id: 'conv-1', logical_turn_id: 'logical', revision: 2,
      source_event_id: 'second-segment',
    }, { segment_stability: 'immediate', supersede_scope: 'response_only' },
    { commit_authority: 'external_adapter' });
    const interactionContext = getTrustedInteractionContext(req);
    mockGenerationJobManager.createJob.mockResolvedValueOnce({
      createdAt: 2,
      abortController: { signal: { aborted: false }, abort: jest.fn() },
      readyPromise: Promise.resolve(), emitter: new EventEmitter(),
      metadata: { interactionContext },
      supersededPresentations: [{
        conversationId: change === 'other-conversation' ? 'other' : 'conv-1',
        responseMessageId: 'response-b',
        userMessageId: change === 'missing-user' ? undefined : 'user-a',
        interactionContext: { logical_turn_id: change === 'other-turn' ? 'other' : 'logical',
          revision: change === 'not-older' ? 2 : 1 },
      }],
    });
    const client = makeClient(Promise.resolve());
    await AgentController(req, makeRes(), jest.fn(), jest.fn(async () => ({ client })), jest.fn());
    await jest.advanceTimersByTimeAsync(120);
    const expectedParent = change === 'matching' ? 'user-a' : 'response-b';
    expect(req.body.parentMessageId).toBe(expectedParent);
    expect(client.sendMessage).toHaveBeenCalledWith('hello', expect.objectContaining({ parentMessageId: expectedParent }));
  });

  test('keeps external-adapter output unfinished until its authenticated delivery acknowledgement', async () => {
    const req = makeReq();
    setTrustedInteractionContext(
      req,
      {
        actor_kind: 'external_user',
        origin: 'interactive',
        surface: 'telegram',
        conversation_id: 'conv-1',
        revision: 1,
        source_event_id: 'telegram-update-1',
      },
      { segment_stability: 'immediate', supersede_scope: 'response_and_authoring' },
      { commit_authority: 'external_adapter' },
    );

    const client = makeClient(Promise.resolve());
    // BaseClient may have already saved a normal-looking row; the controller must overwrite it as
    // provisional until the adapter's authenticated presentation receipt arrives.
    client.savedMessageIds.add('resp-msg-1');
    await AgentController(
      req,
      makeRes(),
      jest.fn(),
      jest.fn(async () => ({ client })),
      jest.fn(),
    );
    await jest.advanceTimersByTimeAsync(120);
    await Promise.resolve();

    expect(mockSaveMessage).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        messageId: 'resp-msg-1',
        isCreatedByUser: false,
        unfinished: true,
      }),
      expect.any(Object),
    );
    expect(mockGenerationJobManager.acknowledgeStreamDelivery).not.toHaveBeenCalled();
  });

  test('does not complete a replaced job after Phase B wait', async () => {
    const phaseB = deferred();
    const client = makeClient(phaseB.promise);
    const initializeClient = jest.fn(async () => ({ client }));
    const addTitle = jest.fn();

    mockGenerationJobManager.getJob
      .mockResolvedValueOnce({ createdAt: 1 })
      .mockResolvedValueOnce({ createdAt: 2 });

    await AgentController(makeReq(), makeRes(), jest.fn(), initializeClient, addTitle);
    await jest.advanceTimersByTimeAsync(120);
    await Promise.resolve();

    expect(mockGenerationJobManager.emitDone).toHaveBeenCalled();
    expect(mockGenerationJobManager.completeJob).not.toHaveBeenCalled();

    phaseB.resolve();
    await jest.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(mockGenerationJobManager.completeJob).not.toHaveBeenCalled();
  });

  test('falls back to timeout and still completes job when Phase B hangs', async () => {
    process.env.VIVENTIUM_CORTEX_FOLLOWUP_GRACE_S = '0.5';
    const never = new Promise(() => {});
    const client = makeClient(never);
    const initializeClient = jest.fn(async () => ({ client }));
    const addTitle = jest.fn();

    await AgentController(makeReq(), makeRes(), jest.fn(), initializeClient, addTitle);
    await jest.advanceTimersByTimeAsync(120);
    await Promise.resolve();
    expect(mockGenerationJobManager.completeJob).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(450);
    await Promise.resolve();

    expect(mockGenerationJobManager.completeJob).toHaveBeenCalledWith('conv-1');
  });

  test('persists one captured QA receipt on user and assistant rows after request-body mutation', async () => {
    const req = makeReq();
    req.body.viventiumQaRun = true;
    req.body.viventiumQaRunId = 'ANTI-SYNTHETIC-request-receipt';
    const client = makeClient(Promise.resolve());
    const initializeClient = jest.fn(async () => {
      delete req.body.viventiumQaRun;
      delete req.body.viventiumQaRunId;
      return { client };
    });

    await AgentController(req, makeRes(), jest.fn(), initializeClient, jest.fn());
    await jest.advanceTimersByTimeAsync(120);
    await Promise.resolve();
    await Promise.resolve();

    const persistedTurnMessages = mockSaveMessage.mock.calls
      .map((call) => call[1])
      .filter((message) => ['user-msg-1', 'resp-msg-1'].includes(message?.messageId));
    expect(persistedTurnMessages.some((message) => message.messageId === 'user-msg-1')).toBe(true);
    expect(persistedTurnMessages.some((message) => message.messageId === 'resp-msg-1')).toBe(true);
    expect(persistedTurnMessages).not.toHaveLength(0);
    for (const message of persistedTurnMessages) {
      expect(message.metadata).toMatchObject({
        viventium: {
          qaRun: true,
          qaRunId: 'ANTI-SYNTHETIC-request-receipt',
          memoryEligible: false,
        },
      });
    }
  });

  test('returns the original canonical conversation when a lost-response retry claims a duplicate job', async () => {
    const originalConversationId = 'original-canonical-conversation';
    const originalStreamId = 'original-stream-before-lost-response';
    const req = makeReq();
    req.body.conversationId = 'new';
    req.body.messageId = 'stable-user-message';
    req.body.responseMessageId = 'stable-response-message';
    const res = makeRes();
    req._viventiumBeforeGenerationReceipt = jest.fn().mockResolvedValue(undefined);
    mockGenerationJobManager.createJob.mockResolvedValueOnce({
      duplicateOfStreamId: originalStreamId,
      metadata: {
        conversationId: originalConversationId,
        interactionContext: {
          actor_kind: 'external_user',
          origin: 'interactive',
          surface: 'web',
          conversation_id: originalConversationId,
          source_event_id: 'stable-user-message',
          logical_turn_id: 'original-logical-turn',
          revision: 1,
          source_segments: [
            {
              ordinal: 0,
              source_event_id: 'stable-user-message',
              source_index: 0,
              text: 'hello',
            },
          ],
        },
      },
    });

    await AgentController(req, res, jest.fn(), jest.fn(), jest.fn());

    const [actualRetryRequestId, actualUserId, actualRetryConversationId] =
      mockGenerationJobManager.createJob.mock.calls[0];
    expect(actualRetryRequestId).toBe(actualRetryConversationId);
    expect(actualRetryRequestId).not.toBe(originalStreamId);
    expect(actualRetryRequestId).not.toBe(originalConversationId);
    expect(actualUserId).toBe('user-1');
    expect(getTrustedInteractionContext(req)).toMatchObject({
      conversation_id: originalConversationId,
      source_event_id: 'stable-user-message',
      logical_turn_id: 'original-logical-turn',
      revision: 1,
    });
    expect(req._viventiumBeforeGenerationReceipt).toHaveBeenCalledWith(expect.objectContaining({
      streamId: originalStreamId, conversationId: originalConversationId, duplicate: true,
    }));
    expect(req._viventiumBeforeGenerationReceipt.mock.invocationCallOrder[0]).toBeLessThan(res.json.mock.invocationCallOrder[0]);
    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json).toHaveBeenCalledWith({
      streamId: originalStreamId,
      conversationId: originalConversationId,
      status: 'duplicate',
      duplicate: true,
      logical_turn_id: 'original-logical-turn',
      revision: 1,
    });
  });

  test('keeps the logical-turn scope stable when a new-chat start response is lost', async () => {
    const duplicateJob = {
      duplicateOfStreamId: 'original-stream-before-lost-response',
      metadata: {
        conversationId: 'original-canonical-conversation',
        interactionContext: {
          actor_kind: 'external_user',
          origin: 'interactive',
          surface: 'web',
          conversation_id: 'original-canonical-conversation',
          source_event_id: 'stable-user-message',
          logical_turn_id: 'original-logical-turn',
          revision: 1,
        },
      },
    };
    mockGenerationJobManager.createJob.mockResolvedValue(duplicateJob);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const req = makeReq();
      req.body.conversationId = 'new';
      req.body.messageId = 'stable-user-message';
      req.body.responseMessageId = 'stable-response-message';
      await AgentController(req, makeRes(), jest.fn(), jest.fn(), jest.fn());
    }

    const firstConversationId = mockGenerationJobManager.createJob.mock.calls[0][2];
    const retryConversationId = mockGenerationJobManager.createJob.mock.calls[1][2];
    expect(firstConversationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(retryConversationId).toBe(firstConversationId);
  });
});

/* === VIVENTIUM START ===
 * Feature: voice task cancellation suppression barrier
 * Purpose: A remote owner may finish after cancellation; its assistant output must never become
 * conversation state, while the already-spoken owner request remains durable.
 * === VIVENTIUM END === */
describe('voice task cancellation persistence barrier', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsVoiceTaskSuppressed.mockReturnValue(true);
  });

  test('suppresses assistant persistence after cancellation but preserves the user turn', async () => {
    const req = makeReq();
    req.body.viventiumVoiceTaskId = 'voice-task-cancelled';
    const { timedSaveMessage } = AgentController.__testables;

    const suppressed = await timedSaveMessage(
      req,
      { messageId: 'assistant-late', isCreatedByUser: false, text: 'late remote result' },
      { context: 'test' },
      'db_save_response',
    );
    const preserved = await timedSaveMessage(
      req,
      { messageId: 'owner-turn', isCreatedByUser: true, text: 'please research this' },
      { context: 'test' },
      'db_save_user',
    );

    expect(suppressed).toEqual({ suppressed: true, taskId: 'voice-task-cancelled' });
    expect(preserved).toEqual({});
    expect(mockSaveMessage).toHaveBeenCalledTimes(1);
    expect(mockSaveMessage.mock.calls[0][1].messageId).toBe('owner-turn');
  });

  test('removes an assistant result when cancellation lands during the database save', async () => {
    const req = makeReq();
    req.body.viventiumVoiceTaskId = 'voice-task-race';
    const save = deferred();
    mockIsVoiceTaskSuppressed.mockReturnValue(false);
    mockSaveMessage.mockImplementationOnce(() => save.promise);
    mockMessageFindOneAndDelete.mockResolvedValueOnce({ _id: 'assistant-object-id' });
    mockConversationUpdateOne.mockResolvedValueOnce({ modifiedCount: 1 });

    const pending = AgentController.__testables.timedSaveMessage(
      req,
      {
        messageId: 'assistant-race',
        conversationId: 'conv-1',
        isCreatedByUser: false,
        text: 'late result',
      },
      { context: 'test' },
      'db_save_response',
    );
    await Promise.resolve();
    mockIsVoiceTaskSuppressed.mockReturnValue(true);
    save.resolve({ messageId: 'assistant-race' });

    await expect(pending).resolves.toEqual({ suppressed: true, taskId: 'voice-task-race' });
    expect(mockMessageFindOneAndDelete).toHaveBeenCalledWith({
      user: 'user-1',
      messageId: 'assistant-race',
    });
    expect(mockConversationUpdateOne).toHaveBeenCalledWith(
      { user: 'user-1', conversationId: 'conv-1' },
      { $pull: { messages: 'assistant-object-id' } },
    );
  });
});


describe('rapid input before asynchronous initialization', () => {
  beforeEach(() => { jest.clearAllMocks(); mockMessageExists.mockResolvedValue(false); mockSaveMessage.mockResolvedValue({}); });
  const trusted = (req, event) => setTrustedInteractionContext(req, {
    actor_kind:'external_user',origin:'interactive',surface:'telegram',conversation_id:'conv-1',source_event_id:event,
    source_order_scope:'a'.repeat(64),source_sequence:event === 'source-a' ? 1 : 2,
  });
  test('retains source before the slow save and marks it ready only after the raw save', async () => {
    const req=makeReq(); trusted(req,'source-a'); const saved=deferred();
    mockSaveMessage.mockImplementationOnce(() => saved.promise);
    const capture=AgentController.captureAcceptedInteractionInput(req,{conversationId:'conv-1',streamId:'a-stream',text:'First full goal',parentMessageId:'base'});
    for(let i=0;i<6;i++) await Promise.resolve();
    expect(mockGenerationJobManager.retainLogicalTurnInput).toHaveBeenCalledTimes(2);
    expect(mockGenerationJobManager.retainLogicalTurnInput.mock.calls[0][1].source_segments[0]).toMatchObject({text:'First full goal',source_sequence:1,source_parent_message_id:'base'});
    expect(mockGenerationJobManager.retainLogicalTurnInput.mock.calls[0][1].source_segments[0].source_persisted).toBeUndefined();
    saved.resolve({}); await capture;
    expect(mockGenerationJobManager.retainLogicalTurnInput).toHaveBeenCalledTimes(2);
    await AgentController.__testables.captureRequestInteractionContext(req,{conversationId:'conv-1',streamId:'a-stream'});
    expect(mockGenerationJobManager.retainLogicalTurnInput.mock.calls[2][1].source_segments[0].source_persisted).toBe(true);
  });
  test('unresolved ingress does not reuse pending input across an explicit reset', async () => {
    const first=makeReq(); trusted(first,'source-a');
    await AgentController.retainAcceptedInteractionInput(first,{conversationId:'new',text:'First goal'});
    expect(mockGenerationJobManager.retainLogicalTurnInput).not.toHaveBeenCalled();
    const firstId=AgentController.__testables.resolveCanonicalConversationId(first,first.user.id,'new');
    const reset=makeReq(); trusted(reset,'source-b');
    await AgentController.retainAcceptedInteractionInput(reset,{conversationId:'new',text:'After reset'});
    expect(mockGenerationJobManager.retainLogicalTurnInput).not.toHaveBeenCalled();
    const resetId=AgentController.__testables.resolveCanonicalConversationId(reset,reset.user.id,'new');
    expect(resetId).not.toBe(firstId);
  });
  test('uses one canonical fresh conversation before the adapter replaces its request body', async () => {
    const req=makeReq(); trusted(req,'source-a');
    const early=await AgentController.captureAcceptedInteractionInput(req,{conversationId:'new',streamId:'a-stream',text:'First goal',parentMessageId:null});
    const canonical=AgentController.__testables.resolveCanonicalConversationId(req,req.user.id,'new');
    expect(early.conversation_id).toBe(canonical);
    expect(mockSaveMessage).toHaveBeenCalledWith(req,expect.objectContaining({conversationId:canonical,parentMessageId:'00000000-0000-0000-0000-000000000000'}),expect.any(Object));
  });
  test('a resolver reset cannot restore an existing rejected conversation', async () => {
    const req=makeReq();trusted(req,'source-a');
    await AgentController.retainAcceptedInteractionInput(req,{conversationId:'rejected-existing-conversation',text:'Own user goal'});
    const resolved=await AgentController.captureAcceptedInteractionInput(req,{conversationId:'new',parentMessageId:null});
    expect(resolved.conversation_id).not.toBe('rejected-existing-conversation');
    expect(resolved.conversation_id).not.toBe('new');
    expect(mockSaveMessage).toHaveBeenCalledWith(req,expect.objectContaining({conversationId:resolved.conversation_id,text:'Own user goal'}),expect.any(Object));
    expect(mockSaveMessage.mock.calls.every(([,message])=>message.conversationId!=='rejected-existing-conversation')).toBe(true);
    req.body={...req.body,conversationId:resolved.conversation_id};
    expect(AgentController.__testables.resolveCanonicalConversationId(req,req.user.id,req.body.conversationId)).toBe(resolved.conversation_id);
  });
  test('stale initialization sends the existing supersession receipt without initializing or cancelling work', async () => {
    const req=makeReq();trusted(req,'source-a'); const res=makeRes(); const init=jest.fn();
    mockGenerationJobManager.createJob.mockRejectedValueOnce(Object.assign(new Error('newer source'),{code:'source_order_superseded'}));
    await AgentController(req,res,jest.fn(),init,jest.fn());
    expect(mockSaveMessage).toHaveBeenCalledWith(req,expect.objectContaining({text:'hello',isCreatedByUser:true}),expect.any(Object));
    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json).toHaveBeenCalledWith({code:'source_order_superseded',superseded:true,conversationId:'conv-1'});
    expect(init).not.toHaveBeenCalled(); expect(mockGenerationJobManager.completeJob).not.toHaveBeenCalled();
  });
  test('a ready older input releases its preparation receipt when current Main is busy without cancelling work', async () => {
    const req=makeReq();trusted(req,'source-a'); const res=makeRes(); const init=jest.fn();
    require('@librechat/api').bindReadyInputContinuation(req,'original-input',2);
    req._viventiumBeforeGenerationReceipt=jest.fn().mockResolvedValue(undefined);
    mockGenerationJobManager.createJob.mockRejectedValueOnce(Object.assign(new Error('Main is active'),{code:'source_input_waiting'}));
    await AgentController(req,res,jest.fn(),init,jest.fn());
    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json).toHaveBeenCalledWith({code:'source_input_pending',pending:true,conversationId:'conv-1'});
    expect(req._viventiumBeforeGenerationReceipt).toHaveBeenCalledWith({code:'source_input_pending',pending:true,conversationId:'conv-1'});
    expect(req._viventiumBeforeGenerationReceipt.mock.invocationCallOrder[0]).toBeLessThan(res.json.mock.invocationCallOrder[0]);
    expect(init).not.toHaveBeenCalled();expect(mockGenerationJobManager.completeJob).not.toHaveBeenCalled();
  });
  test('failed persistence keeps the source unready and the same source retry repairs it', async () => {
    const first=makeReq();trusted(first,'source-a'); mockSaveMessage.mockRejectedValueOnce(new Error('Mongo temporarily unavailable'));
    await expect(AgentController.__testables.captureRequestInteractionContext(first,{conversationId:'conv-1',streamId:'a-stream'})).rejects.toThrow('Mongo temporarily unavailable');
    expect(mockGenerationJobManager.retainLogicalTurnInput.mock.calls.every(([,context])=>context.source_segments[0].source_persisted !== true)).toBe(true);
    const originalId=mockGenerationJobManager.retainLogicalTurnInput.mock.calls[0][1].source_segments[0].source_message_id;
    const retry=makeReq();trusted(retry,'source-a');
    const repaired=await AgentController.__testables.captureRequestInteractionContext(retry,{conversationId:'conv-1',streamId:'retry-stream'});
    expect(repaired.source_segments[0]).toMatchObject({source_message_id:originalId,source_persisted:true,text:'hello'});
  });
  test('pending source persistence returns a typed retryable status rather than starting partial context', async () => {
    const req=makeReq();trusted(req,'source-b'); const res=makeRes(); const init=jest.fn();
    mockGenerationJobManager.createJob.mockRejectedValueOnce(Object.assign(new Error('Input persistence pending; retry'),{code:'source_input_persistence_pending'}));
    await AgentController(req,res,jest.fn(),init,jest.fn());
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({code:'source_input_persistence_pending',retryable:true}));
    expect(init).not.toHaveBeenCalled(); expect(mockGenerationJobManager.completeJob).not.toHaveBeenCalled();
  });
  test('links only exact owner-scoped source messages in order for the normal history loader', async () => {
    const req=makeReq();trusted(req,'source-c');
    await AgentController.__testables.linkAcceptedInteractionSources(req,{conversation_id:'conv-1',source_event_id:'source-c',source_segments:[
      {source_event_id:'source-a',source_message_id:'a',source_parent_message_id:'base'},
      {source_event_id:'source-b',source_message_id:'b',source_parent_message_id:'base'},
      {source_event_id:'source-c',source_message_id:'c',source_parent_message_id:'base'},
    ]});
    const {Message}=require('~/db/models');
    expect(Message.updateOne).toHaveBeenNthCalledWith(1,{user:'user-1',conversationId:'conv-1',messageId:'b',isCreatedByUser:true,parentMessageId:'base','metadata.viventium.interactionContext.source_event_id':'source-b'},{$set:{parentMessageId:'a'}});
    expect(Message.updateOne).toHaveBeenNthCalledWith(2,expect.objectContaining({messageId:'c','metadata.viventium.interactionContext.source_event_id':'source-c'}),{$set:{parentMessageId:'b'}});
    expect(req.body.parentMessageId).toBe('b');
  });
  test("one trusted generation shares fresh canonical identity across distinct source events", async () => {
    const { createTelegramInteractionContext } = require("@librechat/api");
    const make = (event, generation, requested = "new", owner = "user-1") => {
      const req = makeReq();
      req.user.id = owner;
      setTrustedInteractionContext(
        req,
        createTelegramInteractionContext({
          conversation_id: requested,
          source_event_id: event,
          source_order_scope: "a".repeat(64),
          source_sequence: event === "a" ? 1 : 2,
          conversation_generation: generation,
        }),
      );
      return req;
    };
    const generation = "b".repeat(64);
    const a = make("a", generation),
      b = make("b", generation);
    const resolve = (req) =>
      AgentController.__testables.resolveCanonicalConversationId(
        req,
        req.user.id,
        "new",
      );
    expect(resolve(a)).toBe(resolve(b));
    expect(resolve(make("b", "c".repeat(64)))).not.toBe(resolve(a));
    expect(resolve(make("b", generation, "new", "other-owner"))).not.toBe(
      resolve(a),
    );
    const expiredA = make("a", generation, "previous-chat"),
      expiredB = make("b", generation, "previous-chat");
    expect(resolve(expiredA)).toBe(resolve(expiredB));
    expect(resolve(expiredA)).not.toBe("previous-chat");
    expect(resolve(expiredA)).not.toBe(resolve(a));
  });
});
