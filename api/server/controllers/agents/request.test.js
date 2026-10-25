const { EventEmitter } = require('events');

const mockIsNativeCapacityRefusal = jest.fn();
const mockSettleVoiceTaskGeneration = jest.fn(async () => null);
const mockDisposeClient = jest.fn();
const mockGetFiles = jest.fn(async () => []);
const mockSaveMessage = jest.fn(async (_req, message) => ({
  ...message,
  _id: `saved-${message.messageId}`,
}));
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
const mockSourceHistoryRows = jest.fn(async () => []);
const mockMutateNativeResponseSources = jest.fn(async (_filter, operation) => operation());
const mockOriginalMessage = jest.fn();
const mockConversationUpdateOne = jest.fn();
const mockCommitAcceptedMainTurn = jest.fn(async () => ({ status: 'committed' }));
const mockRecoverSavedNativeResponse = jest.fn();
const mockGetNativeResponse = jest.fn(async () => ({ nativeResponse: { status: 'pending' } }));
const mockRecoverNativeResponse = jest.fn(async () => true);
const mockMarkNativeReplayStored = jest.fn();
const mockEnsureAcceptedMainCompaction = jest.fn(async () => ({ status: 'empty' }));

const mockGenerationJobManager = {
  retainLogicalTurnInput: jest.fn(async (_user, context) => context),
  createJob: jest.fn(),
  commitLogicalTurnAuthor: jest.fn(),
  relinquishLogicalTurnAuthor: jest.fn(),
  markMainResponseComplete: jest.fn(),
  finishNativeResponse: jest.fn(),
  failRevokedNativeResponse: jest.fn(),
  acknowledgeStreamDelivery: jest.fn(),
  completeJob: jest.fn(),
  emitDone: jest.fn(),
  emitChunk: jest.fn(),
  emitError: jest.fn(),
  getJob: jest.fn(),
  settleSupersededGeneration: jest.fn(),
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
  isNativeCapacityRefusal: (...args) => mockIsNativeCapacityRefusal(...args),
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
  captureNativeResponseSource: jest.fn(async (_userId, _conversationId, messageId) => ({
    id: 'saved-source',
    messageId,
    digest: 'a'.repeat(64),
  })),
}));

jest.mock('~/db/models', () => ({
  // The completion-error factory loads the existing Cortex service but performs no model I/O.
  ViventiumCortexInsightDelivery: {},
  Message: {
    exists: (...args) => mockMessageExists(...args),
    find: (...args) => ({ select: () => ({ lean: () => mockSourceHistoryRows(...args) }) }),
    findOne: (...args) => ({
      select: () => ({
        lean: async () => {
          const original = await mockOriginalMessage(...args);
          return original === undefined
            ? (await mockMessageExists(...args))
              ? {}
              : null
            : original;
        },
      }),
    }),
    updateOne: jest.fn(async () => ({ matchedCount: 1, modifiedCount: 1 })),
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
  mutateNativeResponseSources: (...args) => mockMutateNativeResponseSources(...args),
  recoverNativeResponse: (...args) => mockRecoverNativeResponse(...args),
  recoverSavedNativeResponse: (...args) => mockRecoverSavedNativeResponse(...args),
  markNativeResponseReplayStored: (...args) => mockMarkNativeReplayStored(...args),
}));

jest.mock('~/server/services/viventium/ViventiumMainContinuityService', () => ({
  commitAcceptedMainTurnFromPresentation: (...args) => mockCommitAcceptedMainTurn(...args),
}));

jest.mock('~/server/services/viventium/ViventiumMainCompactionService', () => ({
  ensureAcceptedMainCompaction: (...args) => mockEnsureAcceptedMainCompaction(...args),
}));

const AgentController = require('./request');
const {
  bindLogicalTurnContext,
  createSchedulerInteractionContext,
  getTrustedInteractionContext,
  setTrustedInteractionContext,
} = require('~/server/services/viventium/interactionContext');

describe('accepted source ledger before logical claim', () => {
  test('binds a first trusted scheduler source to the admitted conversation before its ledger claim', async () => {
    const req = makeReq();
    req.body.conversationId = 'new';
    req.body.text = 'Gather synthetic context.';
    setTrustedInteractionContext(
      req,
      createSchedulerInteractionContext({
        conversation_id: 'new',
        source_event_id: 'prep-synthetic-source',
      }),
    );
    const context = await AgentController.__testables.captureRequestInteractionContext(req, {
      conversationId: 'canonical-synthetic-conversation',
      streamId: 'prep-synthetic-stream',
    });
    expect(context).toMatchObject({
      actor_kind: 'system',
      origin: 'scheduler',
      conversation_id: 'canonical-synthetic-conversation',
      source_event_id: 'prep-synthetic-source',
    });
    expect(mockGenerationJobManager.retainLogicalTurnInput).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ conversation_id: 'canonical-synthetic-conversation' }),
    );
    expect(context.source_segments).toEqual([
      expect.objectContaining({ text: 'Gather synthetic context.' }),
    ]);
    expect(mockSaveMessage).not.toHaveBeenCalled(); // No invented external-user input permission.
    const { captureMainContextSnapshot, traceMainHistoryAncestry } = jest.requireActual(
      '~/server/services/viventium/ViventiumMainContextService',
    );
    const snapshot = captureMainContextSnapshot(req, {
      agent: { id: 'synthetic-main' },
      visibleMessages: [
        {
          messageId: 'synthetic-current-input',
          role: 'user',
          isCreatedByUser: true,
          text: req.body.text,
        },
      ],
      messages: [{ role: 'user', content: req.body.text }],
      historyAncestry: traceMainHistoryAncestry({
        ownerId: 'user-1',
        conversationId: 'canonical-synthetic-conversation',
        messages: [],
        headId: null,
      }),
    });
    expect(snapshot).toMatchObject({
      conversationId: 'canonical-synthetic-conversation',
      actorKind: 'system',
      origin: 'scheduler',
      memoryEligible: false,
    });
  });

  test.each(['canonical-synthetic-conversation', 'foreign-synthetic-conversation'])(
    'preserves concrete scheduler binding %s for the existing ancestry guard',
    async (boundConversation) => {
      const req = makeReq();
      req.body.text = 'Gather synthetic context.';
      setTrustedInteractionContext(
        req,
        createSchedulerInteractionContext({
          conversation_id: boundConversation,
          source_event_id: 'prep-synthetic-source',
        }),
      );
      const context = await AgentController.__testables.captureRequestInteractionContext(req, {
        conversationId: 'canonical-synthetic-conversation',
        streamId: 'prep-synthetic-stream',
      });
      expect(context.conversation_id).toBe(boundConversation);
      const { captureMainContextSnapshot, traceMainHistoryAncestry } = jest.requireActual(
        '~/server/services/viventium/ViventiumMainContextService',
      );
      const visible = [
        {
          messageId: 'synthetic-current-input',
          role: 'user',
          isCreatedByUser: true,
          text: 'Gather synthetic context.',
        },
      ];
      const capture = () =>
        captureMainContextSnapshot(req, {
          agent: { id: 'synthetic-main' },
          visibleMessages: visible,
          messages: [{ role: 'user', content: 'Gather synthetic context.' }],
          historyAncestry: traceMainHistoryAncestry({
            ownerId: 'user-1',
            conversationId: 'canonical-synthetic-conversation',
            messages: [],
            headId: null,
          }),
        });
      if (boundConversation === 'foreign-synthetic-conversation')
        expect(capture).toThrow(expect.objectContaining({ code: 'source_context_unavailable' }));
      else expect(capture).not.toThrow();
    },
  );

  test('canonical fresh-source binding cannot remap an already claimed logical turn', async () => {
    const req = makeReq();
    setTrustedInteractionContext(
      req,
      createSchedulerInteractionContext({
        conversation_id: 'original-synthetic-conversation',
        source_event_id: 'prep-synthetic-source',
      }),
    );
    const original = getTrustedInteractionContext(req);
    bindLogicalTurnContext(req, {
      ...original,
      logical_turn_id: 'claimed-synthetic-turn',
      revision: 1,
    });
    const context = await AgentController.__testables.captureRequestInteractionContext(req, {
      conversationId: 'different-synthetic-conversation',
      streamId: 'prep-synthetic-stream',
    });
    expect(context).toMatchObject({
      conversation_id: 'original-synthetic-conversation',
      logical_turn_id: 'claimed-synthetic-turn',
      actor_kind: 'system',
      origin: 'scheduler',
    });
  });

  test('captures the accepted text and owner-scoped files without trusting body/header source claims', async () => {
    const req = makeReq();
    req.body.messageId = 'accepted-message';
    req.body.text = '  Keep this exact request.\n';
    req.body.viventiumSourceEventId = 'spoofed-source';
    req.body.viventiumTriggeringSourceSegments = [
      { text: 'spoofed text', source_event_id: 'spoofed' },
    ];
    req.body.interactionContext = { actor_kind: 'system', origin: 'scheduler' };
    req.headers = { 'x-viventium-source-event-id': 'spoofed-header' };
    req.body.files = [
      {
        file_id: 'owned-file',
        filename: 'spoofed.txt',
        source_event_id: 'other-source',
        source_index: 9,
      },
      { file_id: 'foreign-file', filename: 'foreign.txt' },
    ];
    mockGetFiles.mockResolvedValueOnce([
      {
        file_id: 'owned-file',
        filename: 'owned.txt',
        type: 'text/plain',
        bytes: 12,
        media_group_index: 2,
      },
    ]);
    const context = await AgentController.__testables.captureRequestInteractionContext(req, {
      conversationId: 'conv-1',
      streamId: 'stream-1',
    });
    expect(mockGetFiles).toHaveBeenCalledWith(
      { user: 'user-1', file_id: { $in: ['owned-file', 'foreign-file'] } },
      undefined,
      { file_id: 1, filename: 1, type: 1, bytes: 1, media_group_index: 1 },
    );
    expect(context).toMatchObject({
      actor_kind: 'external_user',
      origin: 'interactive',
      source_event_id: 'accepted-message',
    });
    expect(context.source_segments).toEqual([
      expect.objectContaining({
        ordinal: 0,
        source_event_id: 'accepted-message',
        source_index: 0,
        text: '  Keep this exact request.\n',
        source_files: [
          {
            file_id: 'owned-file',
            filename: 'owned.txt',
            type: 'text/plain',
            bytes: 12,
            media_group_index: 2,
          },
        ],
      }),
    ]);
    expect(JSON.stringify(context)).not.toContain('spoofed');
    expect(JSON.stringify(context)).not.toContain('foreign-file');
  });

  test('releases request admission when source-file lookup fails before a job exists', async () => {
    const req = makeReq();
    req.body.files = [{ file_id: 'owned-file' }];
    mockGetFiles.mockRejectedValueOnce(new Error('source lookup unavailable'));
    await expect(AgentController(req, makeRes(), jest.fn(), jest.fn(), jest.fn())).rejects.toThrow(
      'source lookup unavailable',
    );
    expect(mockGenerationJobManager.createJob).not.toHaveBeenCalled();
    expect(mockDecrementPendingRequest).toHaveBeenCalledWith('user-1');
  });

  test('preserves trusted gateway identity and binds accepted text before claim', async () => {
    const req = makeReq();
    setTrustedInteractionContext(req, {
      actor_kind: 'external_user',
      origin: 'interactive',
      surface: 'telegram',
      conversation_id: 'conv-1',
      source_event_id: 'trusted-gateway-event',
    });
    req.body.source_event_id = 'spoofed-source';
    const context = await AgentController.__testables.captureRequestInteractionContext(req, {
      conversationId: 'conv-1',
      streamId: 'stream-1',
    });
    expect(context.source_segments).toEqual([
      expect.objectContaining({
        ordinal: 0,
        source_event_id: 'trusted-gateway-event',
        source_index: 0,
        text: 'hello',
      }),
    ]);
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
    mockGenerationJobManager.settleSupersededGeneration.mockImplementation(
      async (streamId, createdAt) => {
        const current = await mockGenerationJobManager.getJob(streamId);
        return current?.createdAt === createdAt && current.status === 'superseded';
      },
    );
    mockGenerationJobManager.emitDone.mockResolvedValue(undefined);
    mockGenerationJobManager.completeJob.mockResolvedValue(undefined);
    mockGenerationJobManager.markMainResponseComplete.mockResolvedValue(true);
    mockGenerationJobManager.finishNativeResponse.mockResolvedValue(true);
    mockCommitAcceptedMainTurn.mockResolvedValue({ status: 'committed' });
    mockGetNativeResponse.mockResolvedValue({ nativeResponse: { status: 'pending' } });
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

  test.each([
    'released',
    'released_existing_error',
    'unknown',
    'wrong_stream',
    'wrong_owner',
    'wrong_message',
    'wrong_generation',
    'fallback_other_error',
    'fallback_without_proof',
    'fallback_foreign_proof',
  ])(
    'settled generation failure closes its snapshot without granting Native refusal authority: %s',
    async (mode) => {
      const released = mode === 'released' || mode === 'released_existing_error';
      const req = makeReq();
      req.body.streamId = 'stream-1';
      mockIsNativeCapacityRefusal.mockReturnValue(released);
      const marker = {
        invocationId: 'invocation',
        bodySha256: 'a'.repeat(64),
        streamId: 'stream-1',
        userId: 'user-1',
        responseMessageId: 'resp-msg-1',
        jobCreatedAt: 1,
      };
      if (mode === 'wrong_stream') marker.streamId = 'foreign';
      if (mode === 'wrong_owner') marker.userId = 'foreign';
      if (mode === 'wrong_message') marker.responseMessageId = 'foreign';
      if (mode === 'wrong_generation') marker.jobCreatedAt = 2;
      if (mode !== 'unknown') req._viventiumNativeResponseUnaccepted = marker;
      let existingErrorPart;
      const client = makeClient(Promise.resolve());
      client.contentParts = [{ type: 'text', text: 'Known partial progress.' }];
      const original = client.sendMessage.getMockImplementation();
      client.sendMessage.mockImplementation(async (...args) => {
        await original(...args);
        if (mode !== 'unknown')
          req._viventiumNativeResponseUnaccepted = {
            ...marker,
            streamId: mode === 'wrong_stream' ? 'foreign' : req._resumableStreamId,
          };
        const failure = {
          code: mode === 'fallback_other_error' ? 'upstream_unavailable' : 'host_capacity',
        };
        if (mode !== 'fallback_without_proof')
          failure.native_admission = {
            version: 1,
            accepted: false,
            invocation_id: mode === 'fallback_foreign_proof' ? 'foreign' : marker.invocationId,
            body_sha256: marker.bodySha256,
            stream_id: req._resumableStreamId,
            message_id: marker.responseMessageId,
          };
        req._viventiumNativeResponseIdentity = {
          ...marker,
          streamId: req._resumableStreamId,
          userId: 'user-1',
          responseMessageId: 'resp-msg-1',
          jobCreatedAt: 1,
        };
        const error = require('openai').APIError.generate(
          503,
          { error: failure },
          undefined,
          new Headers(),
        );
        require('./client').handleCompletionErrorContentPart({
          contentParts: mode === 'released_existing_error' ? client.contentParts : [],
          err: error,
          req,
          abortController: { signal: { aborted: false } },
          log: { warn: jest.fn(), error: jest.fn() },
        });
        if (mode === 'released_existing_error') {
          existingErrorPart = client.contentParts.find((part) => part.type === 'error');
          Object.assign(existingErrorPart, {
            retry_after_seconds: 5,
            capacity_class: 'resource_pressure',
          });
        }
        throw error;
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
      const save = mockSaveMessage.mock.calls.find(
        ([, message, context]) =>
          message.messageId === 'resp-msg-1' &&
          message.error === true &&
          context.context ===
            'api/server/controllers/agents/request.js - generation error snapshot',
      );
      expect(save).toBeDefined();
      expect(save[1]).toMatchObject({
        error: true,
        text: 'Known partial progress.',
        unfinished: false,
      });
      if (released)
        expect(save[1].content).toContainEqual(
          expect.objectContaining({
            type: 'error',
            error_class: 'host_capacity',
            error: 'Local AI capacity is busy. Please try again shortly.',
          }),
        );
      else expect(save[1].content.some((part) => part.type === 'error')).toBe(true);
      if (mode === 'released_existing_error') {
        const capacityErrors = save[1].content.filter(
          (part) => part.type === 'error' && part.error_class === 'host_capacity',
        );
        expect(capacityErrors).toHaveLength(1);
        expect(capacityErrors[0]).toEqual(existingErrorPart);
        expect(capacityErrors[0]).toMatchObject({
          retry_after_seconds: 5,
          capacity_class: 'resource_pressure',
        });
        expect(save[1].text).not.toContain('Generation interrupted before completion.');
      }
      expect(mockGenerationJobManager.markMainResponseComplete).not.toHaveBeenCalled();
      expect(mockCommitAcceptedMainTurn).not.toHaveBeenCalled();
      expect(mockGenerationJobManager.completeJob).toHaveBeenCalled();
      expect(mockGenerationJobManager.failRevokedNativeResponse).not.toHaveBeenCalled();
    },
  );

  test.each([
    'released',
    'unknown',
    'wrong_stream',
    'wrong_owner',
    'wrong_message',
    'wrong_generation',
    'new_invocation',
    'new_body',
    'healthy_fallback',
  ])(
    'failed unsupported host continuation closes while healthy fallback keeps its delivery owner: %s',
    async (mode) => {
      const req = makeReq();
      req.body.voiceMode = true;
      setTrustedInteractionContext(
        req,
        {
          actor_kind: 'external_user',
          origin: 'interactive',
          surface: 'voice',
          conversation_id: 'conv-1',
          revision: 1,
          source_event_id: 'voice-source',
        },
        { segment_stability: 'immediate', supersede_scope: 'response_only' },
        { commit_authority: 'external_adapter' },
      );
      mockRecoverSavedNativeResponse.mockResolvedValueOnce(null);
      const client = makeClient(Promise.resolve());
      client.contentParts = [{ type: 'text', text: 'Known partial progress.' }];
      const original = client.sendMessage.getMockImplementation();
      client.sendMessage.mockImplementation(async (...args) => {
        const result = await original(...args);
        const identity = {
          streamId: req._resumableStreamId,
          jobCreatedAt: 1,
          userId: 'user-1',
          responseMessageId: 'resp-msg-1',
          invocationId: 'current',
          bodySha256: 'a'.repeat(64),
        };
        req._viventiumNativeResponseIdentity = identity;
        if (mode !== 'unknown')
          req._viventiumNativeResponseUnaccepted = {
            ...identity,
            terminalErrorConfirmed: true,
            ...(mode === 'wrong_stream' ? { streamId: 'foreign' } : {}),
            ...(mode === 'wrong_owner' ? { userId: 'foreign' } : {}),
            ...(mode === 'wrong_message' ? { responseMessageId: 'foreign' } : {}),
            ...(mode === 'wrong_generation' ? { jobCreatedAt: 2 } : {}),
            ...(mode === 'new_invocation' ? { invocationId: 'prior' } : {}),
            ...(mode === 'new_body' ? { bodySha256: 'b'.repeat(64) } : {}),
          };
        mockGetNativeResponse.mockResolvedValue({
          nativeResponse: { ...identity, status: 'unsupported' },
        });
        result.content =
          mode === 'healthy_fallback'
            ? [{ type: 'text', text: 'The answer.' }]
            : [
                {
                  type: 'error',
                  error_class: 'host_capacity',
                  error: 'Local AI capacity is busy. Please try again shortly.',
                },
              ];
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
      const save = mockSaveMessage.mock.calls.find(
        ([, , context]) =>
          context.context ===
          (mode !== 'healthy_fallback'
            ? 'api/server/controllers/agents/request.js - generation error snapshot'
            : 'native graph continuation owned by the host'),
      );
      expect(save).toBeDefined();
      if (mode !== 'healthy_fallback') {
        expect(save[1].unfinished).toBe(false);
        expect(save[1].error).toBe(true);
        expect(mockGenerationJobManager.markMainResponseComplete).not.toHaveBeenCalled();
        expect(mockCommitAcceptedMainTurn).not.toHaveBeenCalled();
      } else {
        expect(
          mockSaveMessage.mock.calls.some(
            ([, , context]) =>
              context.context ===
              'api/server/controllers/agents/request.js - generation error snapshot',
          ),
        ).toBe(false);
      }
      expect(mockGenerationJobManager.failRevokedNativeResponse).not.toHaveBeenCalled();
    },
  );

  test.each(['no subscriber', 'disconnected subscriber'])(
    'settles voice generation with %s after actual completion',
    async (mode) => {
      const req = makeReq();
      req.viventiumCallSession = { callSessionId: 'call-1' };
      req.body.viventiumVoiceTaskId = 'task-1';
      req.body.streamId = 'stream-1';
      const res = makeRes();
      const pending = deferred();
      const client = makeClient(Promise.resolve());
      const original = client.sendMessage.getMockImplementation();
      client.sendMessage.mockImplementation(async (...args) => {
        await pending.promise;
        return original(...args);
      });
      await AgentController(
        req,
        res,
        jest.fn(),
        jest.fn(async () => ({ client })),
        jest.fn(),
      );
      await jest.advanceTimersByTimeAsync(120);
      if (mode === 'disconnected subscriber') res.writableEnded = true;
      expect(mockSettleVoiceTaskGeneration).not.toHaveBeenCalled();
      pending.resolve();
      await jest.advanceTimersByTimeAsync(120);
      expect(mockSettleVoiceTaskGeneration).toHaveBeenCalledWith(
        'task-1',
        {
          userId: 'user-1',
          callSessionId: 'call-1',
          streamId: 'stream-1',
        },
        { resultMessageId: 'resp-msg-1' },
      );
    },
  );

  test.each([
    [
      'source_context_unavailable',
      'The conversation context could not be preserved. Please retry this turn.',
    ],
    [undefined, 'Viventium could not complete this request. Please try again.'],
  ])(
    'relays a public typed generation failure without internal diagnostic text (%s)',
    async (code, expected) => {
      const error = Object.assign(new Error('synthetic-private-diagnostic'), code ? { code } : {});
      const client = makeClient(Promise.resolve());
      client.sendMessage.mockRejectedValue(error);
      const req = makeReq();
      req.body.streamId = 'stream-1';
      await AgentController(
        req,
        makeRes(),
        jest.fn(),
        jest.fn(async () => ({ client })),
        jest.fn(),
      );
      await jest.advanceTimersByTimeAsync(120);
      expect(mockGenerationJobManager.emitError).toHaveBeenCalledWith(
        'conv-1',
        expected,
        code || 'completion_error',
      );
      expect(mockGenerationJobManager.completeJob).toHaveBeenCalledWith('conv-1', expected);
      expect(JSON.stringify(mockGenerationJobManager.emitError.mock.calls)).not.toContain(
        'synthetic-private-diagnostic',
      );
    },
  );
  test.each(['flag_only', 'typed_error', 'authored_partial'])(
    'an externally acknowledged unsupported host failure closes without a pending ACK (%s)',
    async (kind) => {
      const req = makeReq();
      req.body.voiceMode = true;
      req.body.viventiumVoiceTaskId = 'task-failed-host';
      req.body.streamId = 'stream-1';
      req.viventiumCallSession = { callSessionId: 'call-1' };
      setTrustedInteractionContext(
        req,
        {
          actor_kind: 'external_user',
          origin: 'interactive',
          surface: 'voice',
          conversation_id: 'conv-1',
          revision: 1,
          source_event_id: 'voice-failed-fallback',
        },
        { segment_stability: 'immediate', supersede_scope: 'response_only' },
        { commit_authority: 'external_adapter' },
      );
      req._viventiumNativeResponseIdentity = { invocationId: 'unsupported-host' };
      mockRecoverSavedNativeResponse.mockResolvedValueOnce(null);
      mockGetNativeResponse.mockResolvedValue({ nativeResponse: { status: 'unsupported' } });
      const client = makeClient(Promise.resolve());
      client.admitMemoryWriter = jest.fn(async () => true);
      const addTitle = jest.fn();
      const part = {
        type: 'error',
        error_class: 'source_context_unavailable',
        error: 'The conversation context could not be preserved. Please retry this turn.',
      };
      const cortex = {
        type: 'cortex_insight',
        cortex_id: 'supporting-evidence',
        insight: 'Private supporting evidence.',
      };
      const content = [
        cortex,
        ...(kind === 'typed_error' ? [part] : []),
        ...(kind === 'authored_partial' ? [{ type: 'text', text: 'Saved partial words.' }] : []),
      ];
      const original = client.sendMessage.getMockImplementation();
      client.sendMessage.mockImplementation(async (...args) => ({
        ...(await original(...args)),
        error: true,
        content,
        text: kind === 'authored_partial' ? 'Saved partial words.' : '',
      }));
      await AgentController(
        req,
        makeRes(),
        jest.fn(),
        jest.fn(async () => ({ client })),
        addTitle,
      );
      await jest.advanceTimersByTimeAsync(120);
      const save = mockSaveMessage.mock.calls.find(
        ([, message, context]) =>
          message.messageId === 'resp-msg-1' &&
          context.context ===
            'api/server/controllers/agents/request.js - generation error snapshot',
      );
      expect(save).toBeDefined();
      expect(save[1]).toMatchObject({ error: true, unfinished: false });
      expect(save[1].content).toContainEqual(cortex);
      expect(save[1].content.filter((item) => item.type === 'error')).toHaveLength(1);
      expect(save[1].text).toBe(kind === 'authored_partial' ? 'Saved partial words.' : '');
      expect(client.admitMemoryWriter).not.toHaveBeenCalled();
      expect(mockSettleVoiceTaskGeneration).toHaveBeenCalledWith(
        'task-failed-host',
        expect.objectContaining({ streamId: 'stream-1' }),
        { error: expect.any(Error) },
      );
      expect(mockGenerationJobManager.emitDone).not.toHaveBeenCalled();
      expect(mockGenerationJobManager.emitError).toHaveBeenCalledTimes(1);
      expect(mockGenerationJobManager.completeJob).toHaveBeenCalledTimes(1);
      expect(mockGenerationJobManager.acknowledgeStreamDelivery).not.toHaveBeenCalled();
      expect(mockGenerationJobManager.markMainResponseComplete).not.toHaveBeenCalled();
      expect(mockCommitAcceptedMainTurn).not.toHaveBeenCalled();
      expect(addTitle).not.toHaveBeenCalled();
    },
  );

  test.each(['settled', 'user_cancelled', 'superseded'])(
    'an error-publication failure preserves the %s presentation owner',
    async (mode) => {
      const req = makeReq();
      req.body.streamId = 'stream-1';
      const signal = { aborted: false };
      mockGenerationJobManager.createJob.mockResolvedValue({
        createdAt: 1,
        abortController: { signal, abort: jest.fn() },
        readyPromise: Promise.resolve(),
        emitter: new EventEmitter(),
      });
      const client = makeClient(Promise.resolve());
      client.contentParts = [{ type: 'text', text: 'Partial authored words.' }];
      const original = client.sendMessage.getMockImplementation();
      client.sendMessage.mockImplementation(async (...args) => {
        await original(...args);
        throw Object.assign(new Error('Public failure.'), { code: 'source_context_unavailable' });
      });
      mockGenerationJobManager.emitError.mockImplementationOnce(async () => {
        if (mode === 'user_cancelled') signal.aborted = true;
        if (mode === 'superseded') {
          mockGenerationJobManager.getJob.mockResolvedValue({ createdAt: 1, status: 'superseded' });
        }
        throw Object.assign(new Error('Public failure.'), { code: 'source_context_unavailable' });
      });
      await AgentController(
        req,
        makeRes(),
        jest.fn(),
        jest.fn(async () => ({ client })),
        jest.fn(),
      );
      await jest.advanceTimersByTimeAsync(120);
      const outer = mockSaveMessage.mock.calls.filter(
        ([, , context]) =>
          context.context ===
          'api/server/controllers/agents/request.js - unhandled generation error snapshot',
      );
      if (mode === 'settled') {
        expect(outer).toHaveLength(1);
        expect(outer[0][1]).toMatchObject({
          error: true,
          unfinished: false,
          text: 'Partial authored words.',
        });
        expect(outer[0][1].content.filter((item) => item.type === 'error')).toHaveLength(1);
      } else {
        expect(outer).toHaveLength(0);
      }
      expect(mockDecrementPendingRequest).toHaveBeenCalledTimes(1);
    },
  );

  test('a typed completion failure persists as failed with its original content', async () => {
    const req = makeReq();
    const client = makeClient(Promise.resolve());
    const original = client.sendMessage.getMockImplementation();
    const content = [
      { type: 'error', error_class: 'source_context_unavailable', error: 'Public failure.' },
      { type: 'cortex_insight', cortex_id: 'synthetic-cortex', insight: 'Retained insight.' },
    ];
    client.sendMessage.mockImplementation(async (...args) => ({
      ...(await original(...args)),
      text: '',
      content,
      error: false,
    }));
    await AgentController(
      req,
      makeRes(),
      jest.fn(),
      jest.fn(async () => ({ client })),
      jest.fn(),
    );
    await jest.advanceTimersByTimeAsync(120);
    expect(mockSaveMessage).toHaveBeenCalledWith(
      req,
      expect.objectContaining({ messageId: 'resp-msg-1', content, error: true, unfinished: false }),
      expect.any(Object),
    );
  });

  test.each(['', 'Partial authored words.'])(
    'a thrown completion failure retains failed truth and authored text (%s)',
    async (text) => {
      const req = makeReq();
      const client = makeClient(Promise.resolve());
      const original = client.sendMessage.getMockImplementation();
      client.contentParts = [
        ...(text ? [{ type: 'text', text }] : []),
        { type: 'error', error_class: 'source_context_unavailable', error: 'Public failure.' },
      ];
      client.sendMessage.mockImplementation(async (...args) => {
        await original(...args);
        throw Object.assign(new Error('Public failure.'), { code: 'source_context_unavailable' });
      });
      await AgentController(
        req,
        makeRes(),
        jest.fn(),
        jest.fn(async () => ({ client })),
        jest.fn(),
      );
      await jest.advanceTimersByTimeAsync(120);
      expect(mockSaveMessage).toHaveBeenCalledWith(
        req,
        expect.objectContaining({
          messageId: 'resp-msg-1',
          error: true,
          unfinished: false,
          ...(text ? { text } : {}),
        }),
        expect.any(Object),
      );
    },
  );
  test('saves an accepted interactive input and its send as one user message', async () => {
    const req = makeReq();
    setTrustedInteractionContext(req, {
      actor_kind: 'external_user',
      origin: 'interactive',
      surface: 'web',
      conversation_id: 'conv-1',
      source_event_id: 'web-source-1',
      source_order_scope: 'b'.repeat(64),
      source_sequence: 1,
    });
    const client = makeClient(Promise.resolve());

    await AgentController(
      req,
      makeRes(),
      jest.fn(),
      jest.fn(async () => ({ client })),
      jest.fn(),
    );
    await jest.advanceTimersByTimeAsync(120);

    const acceptedSaves = mockSaveMessage.mock.calls.filter(
      ([, message]) => message.isCreatedByUser === true,
    );
    expect(acceptedSaves).toHaveLength(1);
    expect(client.sendMessage).toHaveBeenCalledWith(
      'hello',
      expect.objectContaining({ overrideParentMessageId: acceptedSaves[0][1].messageId }),
    );
  });

  test('settles a completed superseded voice generation without reviving its presentation', async () => {
    const req = makeReq();
    req.viventiumCallSession = { callSessionId: 'call-1' };
    req.body.viventiumVoiceTaskId = 'task-1';
    req.body.streamId = 'stream-1';
    mockGenerationJobManager.getJob.mockResolvedValue({ createdAt: 1, status: 'superseded' });
    await AgentController(
      req,
      makeRes(),
      jest.fn(),
      jest.fn(async () => ({ client: makeClient(Promise.resolve()) })),
      jest.fn(),
    );
    await jest.advanceTimersByTimeAsync(120);
    expect(mockSettleVoiceTaskGeneration).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({ streamId: 'stream-1' }),
      {},
    );
    expect(mockGenerationJobManager.emitDone).not.toHaveBeenCalled();
    expect(mockGenerationJobManager.completeJob).not.toHaveBeenCalled();
  });

  test.each(['generation', 'initialization'])(
    'settles a real voice %s failure without a subscriber',
    async (stage) => {
      const req = makeReq();
      req.viventiumCallSession = { callSessionId: 'call-1' };
      req.body.viventiumVoiceTaskId = 'task-1';
      req.body.streamId = 'stream-1';
      const error = Object.assign(new Error('Provider unavailable'), {
        code: 'provider_unavailable',
      });
      const client = makeClient(Promise.resolve());
      const initialize = jest.fn(async () => ({ client }));
      if (stage === 'generation') client.sendMessage.mockRejectedValue(error);
      else initialize.mockRejectedValue(error);
      await AgentController(req, makeRes(), jest.fn(), initialize, jest.fn());
      await jest.advanceTimersByTimeAsync(120);
      expect(mockSettleVoiceTaskGeneration).toHaveBeenCalledWith(
        'task-1',
        expect.objectContaining({ streamId: 'stream-1' }),
        { error },
      );
    },
  );

  test('resumable requests retain guarded assistant persistence ownership', async () => {
    const client = makeClient(Promise.resolve());
    await AgentController(
      makeReq(),
      makeRes(),
      jest.fn(),
      jest.fn(async () => ({ client })),
      jest.fn(),
    );
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
          hasError ? expectedError : 'Viventium could not complete this request. Please try again.',
          hasError ? 'provider_temporarily_unavailable' : 'completion_error',
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

  test.each([
    ['current revoked Native identity', 'current', true],
    ['current Voice Native identity', 'current_voice', true],
    ['current Telegram Native identity', 'current_telegram', true],
    ['wrong Native owner', 'wrong_owner', false],
    ['wrong Native invocation', 'wrong_invocation', false],
    ['wrong job incarnation', 'wrong_incarnation', false],
    ['another exact Native stream', 'other_stream', false],
    ['a superseded revision', 'superseded', false],
    ['an unrevoked Native publication', 'unrevoked', false],
    ['an accepted final owner', 'committed', false],
    ['an accepted final before publication', 'committed_pending', false],
    ['a finished Stop owner', 'stopped', false],
    ['an untyped lookalike error', 'untyped', false],
    ['a different typed failure', 'different_error', false],
    ['a non-Native request', 'non_native', false],
  ])('missing canonical row finalization preserves %s', async (_label, mode, shouldFailRevoked) => {
    const { GenerationJobManagerClass, InMemoryJobStore, InMemoryEventTransport } =
      jest.requireActual('@librechat/api');
    const store = new InMemoryJobStore();
    const transport = new InMemoryEventTransport();
    const manager = new GenerationJobManagerClass({ jobStore: store, eventTransport: transport });
    const streamId = 'conv-1';
    await manager.createJob(streamId, 'user-1', 'conv-1', {
      interactionContext: {
        actor_kind: 'external_user',
        origin: 'interactive',
        surface:
          mode === 'current_voice' ? 'voice' : mode === 'current_telegram' ? 'telegram' : 'web',
        conversation_id: 'conv-1',
        revision: 1,
        source_event_id: 'user-msg-1',
      },
    });
    await manager.updateMetadata(streamId, {
      responseMessageId: 'resp-msg-1',
      userMessage: { messageId: 'user-msg-1' },
    });
    const job = await store.getJob(streamId);
    const claim = { interactionContext: job.interactionContext };
    const admittedAt = Date.now();
    const identity = {
      userId: 'user-1',
      conversationId: 'conv-1',
      responseMessageId: 'resp-msg-1',
      streamId,
      jobCreatedAt: job.createdAt,
      logicalTurnId: claim.interactionContext.logical_turn_id,
      revision: claim.interactionContext.revision,
      invocationId: 'native-invocation',
      bodySha256: 'a'.repeat(64),
      providerId: 'synthetic-provider',
      agentId: 'synthetic-agent',
      originSha256: 'b'.repeat(64),
      source: { id: 'synthetic-source-id', messageId: 'user-msg-1', digest: 'c'.repeat(64) },
      admittedAt,
      recoverUntil: admittedAt + 86_400_000,
    };
    expect(await manager.bindNativeResponse(identity)).toBe(true);
    if (mode === 'committed' || mode === 'committed_pending') {
      await manager.commitNativeResponse(identity, 'd'.repeat(64));
      if (mode === 'committed') {
        await manager.finishNativeResponse(identity, {
          final: true,
          responseMessage: { messageId: identity.responseMessageId, text: 'Accepted answer.' },
        });
      }
    } else if (mode !== 'unrevoked') {
      await manager.revokeNativeResponse(identity);
      if (mode === 'stopped') {
        await manager.finishNativeResponse(
          identity,
          {
            final: true,
            responseMessage: { messageId: identity.responseMessageId, text: 'Stopped partial.' },
          },
          'cancelled',
        );
      }
    }
    let supplied = { ...identity };
    if (mode === 'wrong_owner') supplied.userId = 'another-owner';
    if (mode === 'wrong_invocation') supplied.invocationId = 'another-invocation';
    if (mode === 'wrong_incarnation') supplied.jobCreatedAt += 1;
    if (mode === 'other_stream') {
      const otherClaim = await store.claimLogicalTurn('another-stream', 'user-1', {
        actor_kind: 'external_user',
        origin: 'interactive',
        surface: 'web',
        conversation_id: 'another-conversation',
        revision: 1,
        source_event_id: 'another-source',
      });
      const other = await store.createJob('another-stream', 'user-1', 'another-conversation', {
        responseMessageId: 'another-answer',
        interactionContext: otherClaim.interactionContext,
        userMessage: { messageId: 'user-msg-1' },
      });
      supplied = {
        ...identity,
        streamId: other.streamId,
        jobCreatedAt: other.createdAt,
        conversationId: other.conversationId,
        responseMessageId: other.responseMessageId,
        logicalTurnId: otherClaim.interactionContext.logical_turn_id,
        revision: otherClaim.interactionContext.revision,
      };
      expect(await manager.bindNativeResponse(supplied)).toBe(true);
      await manager.revokeNativeResponse(supplied);
    }
    if (mode === 'superseded') {
      await store.claimLogicalTurn('newer-stream', 'user-1', {
        ...claim.interactionContext,
        revision: claim.interactionContext.revision + 1,
        source_event_id: 'newer-source',
      });
    }
    const before = JSON.stringify(await store.getJob(streamId));
    const publicErrors = jest.spyOn(transport, 'emitError');
    const publicFinals = jest.spyOn(transport, 'emitDone');
    if (shouldFailRevoked) expect(manager.hasLocalNativeResponseProducer(identity)).toBe(true);
    const req = makeReq();
    if (mode === 'current_voice') {
      req.viventiumCallSession = { callSessionId: 'call-1' };
      req.body.voiceMode = true;
      req.body.viventiumVoiceTaskId = 'task-1';
      req.body.streamId = streamId;
    }
    if (mode === 'current_telegram') {
      req._viventiumTelegram = true;
      req.body.viventiumSurface = 'telegram';
      req.body.streamId = streamId;
    }
    if (mode !== 'non_native') req._viventiumNativeResponseIdentity = supplied;
    const code =
      mode === 'untyped'
        ? undefined
        : mode === 'different_error'
          ? 'source_context_unavailable'
          : 'native_response_message_deleted';
    const error = Object.assign(new Error('native_response_message_deleted'), code ? { code } : {});
    const client = makeClient(Promise.resolve());
    client.sendMessage.mockRejectedValueOnce(error);
    mockGenerationJobManager.createJob.mockResolvedValueOnce({
      createdAt: job.createdAt,
      abortController: { signal: { aborted: false }, abort: jest.fn() },
      readyPromise: Promise.resolve(),
      emitter: new EventEmitter(),
    });
    mockGenerationJobManager.getJob.mockImplementation(async () => ({ createdAt: job.createdAt }));
    // Use the actual identity fence and producer cleanup for revoked and Stop owners. Other
    // refusals keep generic finalization mocked to isolate this candidate's store mutation.
    mockGenerationJobManager.failRevokedNativeResponse.mockImplementationOnce((...args) =>
      manager.failRevokedNativeResponse(...args),
    );
    if (shouldFailRevoked || mode === 'stopped') {
      mockGenerationJobManager.completeJob.mockImplementationOnce((...args) =>
        manager.completeJob(...args),
      );
    }
    await AgentController(
      req,
      makeRes(),
      jest.fn(),
      jest.fn(async () => ({ client })),
      jest.fn(),
    );
    await jest.advanceTimersByTimeAsync(120);
    await Promise.resolve();
    if (shouldFailRevoked) {
      expect(await store.getJob(streamId)).toMatchObject({
        status: 'error',
        error: 'Viventium could not complete this request. Please try again.',
      });
      expect(publicErrors).toHaveBeenCalledTimes(1);
      expect(publicErrors).toHaveBeenCalledWith(
        streamId,
        'Viventium could not complete this request. Please try again.',
        'completion_error',
      );
      expect(mockGenerationJobManager.emitError).not.toHaveBeenCalled();
      expect(manager.hasLocalNativeResponseProducer(identity)).toBe(false);
    } else {
      expect(JSON.stringify(await store.getJob(streamId))).toBe(before);
      expect(publicErrors).not.toHaveBeenCalled();
      expect(mockGenerationJobManager.emitError).toHaveBeenCalled();
    }
    expect(mockGenerationJobManager.completeJob).toHaveBeenCalledWith(
      streamId,
      mode === 'different_error'
        ? 'The conversation context could not be preserved. Please retry this turn.'
        : 'Viventium could not complete this request. Please try again.',
    );
    expect(publicFinals).not.toHaveBeenCalled();
    if (mode === 'stopped') {
      expect((await store.getJob(streamId)).finalEvent).toBe(JSON.parse(before).finalEvent);
    }
    if (['untyped', 'different_error', 'non_native', 'other_stream'].includes(mode)) {
      expect(mockGenerationJobManager.failRevokedNativeResponse).not.toHaveBeenCalled();
    } else if (shouldFailRevoked) {
      expect(mockGenerationJobManager.failRevokedNativeResponse).toHaveBeenCalledWith(
        supplied,
        'Viventium could not complete this request. Please try again.',
        'completion_error',
      );
    }
    if (mode === 'other_stream') {
      expect(await store.getJob('another-stream')).toMatchObject({ status: 'running' });
    }
    expect(JSON.stringify(publicErrors.mock.calls)).not.toContain(
      'native_response_message_deleted',
    );
    mockGenerationJobManager.getJob.mockResolvedValue({ createdAt: 1 });
    mockGenerationJobManager.failRevokedNativeResponse.mockReset();
  });

  test.each([
    ['a source change revoked it before it finished', { status: 'cancelled' }, true],
    ['Stop saved its snapshot', { status: 'cancelled', stopSnapshotStoredAt: 1 }, false],
    ['it is still pending', { status: 'pending' }, false],
  ])(
    'ends a native stream with a typed failure only when %s',
    async (_label, admission, revoked) => {
      const req = makeReq();
      req._viventiumNativeResponseIdentity = { invocationId: 'exact-native' };
      const identity = req._viventiumNativeResponseIdentity;
      mockRecoverSavedNativeResponse.mockResolvedValueOnce(null);
      mockGetNativeResponse.mockResolvedValueOnce({ nativeResponse: admission });
      mockGenerationJobManager.failRevokedNativeResponse.mockResolvedValueOnce(true);

      await AgentController(
        req,
        makeRes(),
        jest.fn(),
        jest.fn(async () => ({ client: makeClient(Promise.resolve()) })),
        jest.fn(),
      );
      await jest.advanceTimersByTimeAsync(120);
      await Promise.resolve();

      if (revoked) {
        expect(mockGenerationJobManager.failRevokedNativeResponse).toHaveBeenCalledWith(
          identity,
          'native_response_revoked',
        );
      } else {
        expect(mockGenerationJobManager.failRevokedNativeResponse).not.toHaveBeenCalled();
      }
      expect(mockGenerationJobManager.emitError).toHaveBeenCalledWith(
        expect.any(String),
        'Viventium could not complete this request. Please try again.',
        'completion_error',
      );
      expect(mockGenerationJobManager.finishNativeResponse).not.toHaveBeenCalled();
    },
  );

  test.each([
    'native_input_declined',
    'native_input_expired',
    'native_input_cancelled',
    'native_turn_cancelled',
  ])('native terminal settles the Voice task with its typed failure %s', async (code) => {
    const req = makeReq();
    req.viventiumCallSession = { callSessionId: 'call-1' };
    req.body.viventiumVoiceTaskId = 'task-1';
    req.body.streamId = 'stream-1';
    req._viventiumNativeResponseIdentity = { invocationId: 'exact-native' };
    mockRecoverSavedNativeResponse.mockImplementationOnce(async (_identity, onTerminal) => {
      onTerminal('failed');
      return {
        messageId: 'resp-msg-1',
        error: true,
        unfinished: false,
        content: [{ type: 'error', error_class: code, error: 'Public stop message.' }],
      };
    });
    await AgentController(
      req,
      makeRes(),
      jest.fn(),
      jest.fn(async () => ({ client: makeClient(Promise.resolve()) })),
      jest.fn(),
    );
    await jest.advanceTimersByTimeAsync(120);
    expect(mockSettleVoiceTaskGeneration).toHaveBeenCalledWith(
      'task-1',
      { userId: 'user-1', callSessionId: 'call-1', streamId: 'stream-1' },
      { resultMessageId: 'resp-msg-1', error: { code, message: 'Public stop message.' } },
    );
    expect(mockGenerationJobManager.emitError).not.toHaveBeenCalled();
  });

  test('authoritative native terminal bypasses memory, accepted continuity, and title success paths', async () => {
    const req = makeReq();
    req._viventiumNativeResponseIdentity = { invocationId: 'exact-native' };
    const client = makeClient(Promise.resolve());
    client.admitMemoryWriter = jest.fn();
    const addTitle = jest.fn();
    mockRecoverSavedNativeResponse.mockImplementationOnce(async (_identity, onTerminal) => {
      onTerminal('cancelled');
      return {
        messageId: 'resp-msg-1',
        error: true,
        unfinished: false,
        content: [
          {
            type: 'error',
            error_class: 'native_response_cancelled',
            error: 'The response was cancelled before completion.',
          },
        ],
      };
    });
    await AgentController(
      req,
      makeRes(),
      jest.fn(),
      jest.fn(async () => ({ client })),
      addTitle,
    );
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
          'Viventium could not complete this request. Please try again.',
          'completion_error',
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
      'Viventium could not complete this request. Please try again.',
      'completion_error',
    );
  });

  test('authors a web InteractionContext and does not trust privileged request fields', async () => {
    const receivedAt = Date.now();
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

    expect(mockGenerationJobManager.createJob).toHaveBeenCalledWith(
      expect.any(String),
      'user-1',
      'conv-1',
      {
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
          source_received_at: receivedAt,
          source_segments: [
            {
              ordinal: 0,
              source_event_id: 'web-source-event-1',
              source_index: 0,
              source_message_id: '56be50c6-fe73-54f0-a4c5-0b2ed6e038eb',
              source_parent_message_id: '00000000-0000-0000-0000-000000000000',
              source_persisted: true,
              source_received_at: receivedAt,
              text: 'hello',
            },
          ],
        },
        deliveryPolicy: { commit_authority: 'server' },
      },
    );
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

  test.each(['telegram', 'voice'])(
    'an accepted effect cannot authorize obsolete assistant persistence on %s',
    async (surface) => {
      const req = makeReq();
      req._resumableStreamId = 'old-stream';
      const context = {
        actor_kind: 'human',
        origin: 'interactive',
        surface,
        conversation_id: 'conv-1',
        source_event_id: 'source-old',
        logical_turn_id: 'turn-old',
        revision: 1,
      };
      setTrustedInteractionContext(
        req,
        context,
        { segment_stability: 'provisional', supersede_scope: 'response_only' },
        { commit_authority: 'external_adapter' },
      );
      const receipt = {
        effect_kind: 'durable_work_accepted',
        effect_ref: 'work-old',
        source_event_id: 'source-old',
        response_message_id: 'answer-old',
        committed_at: 1,
      };
      mockGenerationJobManager.getJob.mockResolvedValue({
        status: 'superseded',
        interactionContext: context,
        responseMessageId: 'answer-old',
        adapterCapabilities: { supersede_scope: 'response_only' },
        deliveryPolicy: { commit_authority: 'external_adapter' },
        durableEffectReceipt: receipt,
      });
      const result = await AgentController.__testables.timedSaveMessage(
        req,
        {
          messageId: 'answer-old',
          conversationId: 'conv-1',
          isCreatedByUser: false,
          text: 'Accepted operation.',
        },
        {},
        'db_save_test',
      );
      expect(result).toEqual({ suppressed: true, reason: 'superseded' });
      expect(mockSaveMessage).not.toHaveBeenCalled();
      expect(mockMessageFindOneAndDelete).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: 'answer-old', unfinished: true }),
      );
      expect((await mockGenerationJobManager.getJob()).durableEffectReceipt).toEqual(receipt);
    },
  );

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
    req.viventiumCallSession = { callSessionId: 'call-1' };
    req.body.viventiumVoiceTaskId = 'task-1';
    req.body.streamId = 'stream-1';
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
    expect(mockSettleVoiceTaskGeneration).toHaveBeenCalledTimes(1);
    expect(mockSettleVoiceTaskGeneration).toHaveBeenCalledWith(
      'task-1',
      { userId: 'user-1', callSessionId: 'call-1', streamId: 'stream-1' },
      {},
    );
  });

  test('finishes a revision replaced while its obsolete operation failed, without an error answer', async () => {
    const req = makeReq();
    req.viventiumCallSession = { callSessionId: 'call-1' };
    req.body.viventiumVoiceTaskId = 'task-1';
    req.body.streamId = 'stream-1';
    const abortSignal = { aborted: false, reason: undefined };
    mockGenerationJobManager.createJob.mockResolvedValueOnce({
      createdAt: 1,
      abortController: { signal: abortSignal, abort: jest.fn() },
      readyPromise: Promise.resolve(),
      emitter: new EventEmitter(),
    });
    mockGenerationJobManager.getJob.mockResolvedValue({ createdAt: 1, status: 'superseded' });
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
        'response-a',
        true,
      );
      throw Object.assign(new Error('provider_response_failed'), { status: 409 });
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

    expect(mockGenerationJobManager.emitError).not.toHaveBeenCalled();
    expect(mockSettleVoiceTaskGeneration).toHaveBeenCalledTimes(1);
    expect(mockSettleVoiceTaskGeneration).toHaveBeenCalledWith(
      'task-1',
      { userId: 'user-1', callSessionId: 'call-1', streamId: 'stream-1' },
      {},
    );
    // Finished as superseded (no error argument), never as a failed answer.
    expect(mockGenerationJobManager.completeJob).toHaveBeenCalled();
    expect(mockGenerationJobManager.completeJob.mock.calls.every((call) => call.length === 1)).toBe(
      true,
    );
    expect(mockSaveMessage).not.toHaveBeenCalledWith(
      req,
      expect.objectContaining({ messageId: 'response-a', error: true }),
      expect.anything(),
    );
  });

  test('a newer recorded input suppresses a publication failure before supersede status and abort arrive', async () => {
    const req = makeReq();
    req.viventiumCallSession = { callSessionId: 'call-1' };
    req.body.viventiumVoiceTaskId = 'task-1';
    req.body.streamId = 'stream-1';
    mockGenerationJobManager.getJob.mockResolvedValue({ createdAt: 1, status: 'running' });
    mockGenerationJobManager.settleSupersededGeneration.mockResolvedValueOnce(true);
    const client = makeClient(Promise.resolve());
    client.sendMessage.mockRejectedValueOnce(new Error('native_response_publication_revoked'));

    await AgentController(req, makeRes(), jest.fn(), async () => ({ client }), jest.fn());
    await jest.advanceTimersByTimeAsync(120);

    expect(mockGenerationJobManager.emitError).not.toHaveBeenCalled();
    expect(mockGenerationJobManager.settleSupersededGeneration).toHaveBeenCalledWith('stream-1', 1);
    expect(mockGenerationJobManager.completeJob).toHaveBeenCalledWith('stream-1');
    expect(mockSaveMessage).not.toHaveBeenCalledWith(
      req,
      expect.objectContaining({ error: true }),
      expect.anything(),
    );
    expect(mockSettleVoiceTaskGeneration).toHaveBeenCalledWith(
      'task-1',
      { userId: 'user-1', callSessionId: 'call-1', streamId: 'stream-1' },
      {},
    );
  });

  /* === VIVENTIUM START === Exact supersession task settlement and retained effect receipts. */
  test.each(['superseded', 'user_cancelled'])(
    'settles initialization abort %s through its existing typed outcome',
    async (reason) => {
      const req = makeReq();
      req.viventiumCallSession = { callSessionId: 'call-1' };
      req.body.viventiumVoiceTaskId = 'task-1';
      req.body.streamId = 'stream-1';
      const signal = { aborted: false, reason: undefined };
      mockGenerationJobManager.createJob.mockResolvedValueOnce({
        createdAt: 1,
        abortController: { signal, abort: jest.fn() },
        readyPromise: Promise.resolve(),
        emitter: new EventEmitter(),
      });
      const client = makeClient(Promise.resolve());
      await AgentController(
        req,
        makeRes(),
        jest.fn(),
        async () => {
          signal.aborted = true;
          signal.reason = reason;
          return { client };
        },
        jest.fn(),
      );

      expect(client.sendMessage).not.toHaveBeenCalled();
      expect(mockSettleVoiceTaskGeneration).toHaveBeenCalledWith(
        'task-1',
        { userId: 'user-1', callSessionId: 'call-1', streamId: 'stream-1' },
        reason === 'superseded'
          ? {}
          : {
              error: {
                code: 'generation_aborted',
                message: 'Request aborted during initialization',
              },
            },
      );
      expect(mockGenerationJobManager.completeJob).toHaveBeenCalledWith(
        ...(reason === 'superseded'
          ? ['stream-1']
          : ['stream-1', 'Request aborted during initialization']),
      );
    },
  );

  test.each([
    ['superseded', 'running'],
    ['user_cancelled', 'running'],
    ['superseded', 'missing'],
  ])(
    'settles normal aborted return %s with durable job %s before a delayed status update',
    async (reason, durableState) => {
      const req = makeReq();
      req.viventiumCallSession = { callSessionId: 'call-1' };
      req.body.viventiumVoiceTaskId = 'task-1';
      req.body.streamId = 'stream-1';
      const signal = { aborted: false, reason: undefined };
      mockGenerationJobManager.createJob.mockResolvedValueOnce({
        createdAt: 1,
        abortController: { signal, abort: jest.fn() },
        readyPromise: Promise.resolve(),
        emitter: new EventEmitter(),
      });
      mockGenerationJobManager.getJob.mockResolvedValue(
        durableState === 'missing'
          ? null
          : {
              createdAt: 1,
              status: 'running',
              adapterCapabilities: { supersede_scope: 'response_only' },
            },
      );
      const client = makeClient(Promise.resolve());
      const send = client.sendMessage.getMockImplementation();
      client.sendMessage.mockImplementationOnce(async (...args) => {
        const result = await send(...args);
        signal.aborted = true;
        signal.reason = reason;
        return result;
      });
      await AgentController(req, makeRes(), jest.fn(), async () => ({ client }), jest.fn());
      await jest.advanceTimersByTimeAsync(120);

      expect(mockSettleVoiceTaskGeneration).toHaveBeenCalledTimes(1);
      expect(mockSettleVoiceTaskGeneration).toHaveBeenCalledWith(
        'task-1',
        { userId: 'user-1', callSessionId: 'call-1', streamId: 'stream-1' },
        reason === 'superseded'
          ? {}
          : { error: { code: 'generation_aborted', message: 'Request aborted' } },
      );
      if (reason === 'superseded') {
        expect(mockGenerationJobManager.emitDone).not.toHaveBeenCalled();
        if (durableState === 'missing') {
          expect(mockGenerationJobManager.completeJob).not.toHaveBeenCalled();
        } else {
          expect(mockGenerationJobManager.completeJob).toHaveBeenCalledWith('stream-1');
        }
        expect(mockMessageFindOneAndDelete).toHaveBeenCalledWith(
          expect.objectContaining({ messageId: 'resp-msg-1', user: 'user-1' }),
        );
      }
    },
  );

  test.each([
    [true, 'running', true],
    [false, 'running', true],
    [true, 'superseded', false],
  ])(
    'suppresses obsolete assistant output while retaining effect receipts separately (exact=%s, status=%s, signal=%s)',
    async (exact, status, signalAborted) => {
      const req = makeReq();
      req.viventiumCallSession = { callSessionId: 'call-1' };
      req.body.viventiumVoiceTaskId = 'task-1';
      req.body.streamId = 'stream-1';
      if (!signalAborted) req.body.conversationId = 'new';
      const signal = { aborted: false, reason: undefined };
      mockGenerationJobManager.createJob.mockResolvedValueOnce({
        createdAt: 1,
        abortController: { signal, abort: jest.fn() },
        readyPromise: Promise.resolve(),
        emitter: new EventEmitter(),
      });
      mockGenerationJobManager.getJob.mockImplementation(async () => {
        const interactionContext = getTrustedInteractionContext(req);
        return {
          createdAt: 1,
          status,
          adapterCapabilities: { supersede_scope: 'response_only' },
          deliveryPolicy: { commit_authority: 'external_adapter' },
          responseMessageId: 'resp-msg-1',
          interactionContext,
          durableEffectReceipt: {
            effect_kind: 'durable_work_accepted',
            effect_ref: 'effect-1',
            committed_at: 1,
            response_message_id: 'resp-msg-1',
            source_event_id: exact ? interactionContext?.source_event_id : 'foreign-source',
          },
        };
      });
      const client = makeClient(Promise.resolve());
      client.startDeferredMemoryWriter = jest.fn(async () => ({ status: 'admitted' }));
      client.admitMemoryWriter = jest.fn();
      const addTitle = jest.fn(async () => undefined);
      const send = client.sendMessage.getMockImplementation();
      client.sendMessage.mockImplementationOnce(async (...args) => {
        const result = await send(...args);
        if (signalAborted) {
          signal.aborted = true;
          signal.reason = 'superseded';
        }
        return result;
      });
      await AgentController(req, makeRes(), jest.fn(), async () => ({ client }), addTitle);
      await jest.advanceTimersByTimeAsync(120);

      expect(mockSettleVoiceTaskGeneration).toHaveBeenCalledTimes(1);
      expect(mockSettleVoiceTaskGeneration).toHaveBeenCalledWith(
        'task-1',
        { userId: 'user-1', callSessionId: 'call-1', streamId: 'stream-1' },
        {},
      );
      expect(mockGenerationJobManager.completeJob).toHaveBeenCalledWith('stream-1');
      if (!signalAborted) {
        expect(client.startDeferredMemoryWriter).not.toHaveBeenCalled();
        expect(client.admitMemoryWriter).not.toHaveBeenCalled();
        expect(addTitle).not.toHaveBeenCalled();
        expect(mockGenerationJobManager.markMainResponseComplete).not.toHaveBeenCalled();
        expect(mockCommitAcceptedMainTurn).not.toHaveBeenCalled();
      }
      expect(mockMessageFindOneAndDelete).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: 'resp-msg-1', user: 'user-1' }),
      );
      expect(mockGenerationJobManager.emitDone).not.toHaveBeenCalled();
    },
  );

  test('a superseded unsupported-native graph return cannot start a deferred writer before its signal', async () => {
    const req = makeReq();
    req.viventiumCallSession = { callSessionId: 'call-1' };
    req.body.viventiumVoiceTaskId = 'task-1';
    req.body.streamId = 'stream-1';
    req._viventiumNativeResponseIdentity = { invocationId: 'exact-native' };
    mockGenerationJobManager.getJob.mockResolvedValue({
      createdAt: 1,
      status: 'superseded',
      adapterCapabilities: { supersede_scope: 'response_only' },
    });
    mockRecoverSavedNativeResponse.mockResolvedValueOnce(null);
    mockGetNativeResponse.mockResolvedValueOnce({ nativeResponse: { status: 'unsupported' } });
    const client = makeClient(Promise.resolve());
    client.startDeferredMemoryWriter = jest.fn(async () => ({ status: 'admitted' }));
    await AgentController(req, makeRes(), jest.fn(), async () => ({ client }), jest.fn());
    await jest.advanceTimersByTimeAsync(120);

    expect(client.startDeferredMemoryWriter).not.toHaveBeenCalled();
    expect(mockMessageFindOneAndDelete).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'resp-msg-1', user: 'user-1' }),
    );
    expect(mockSettleVoiceTaskGeneration).toHaveBeenCalledWith(
      'task-1',
      { userId: 'user-1', callSessionId: 'call-1', streamId: 'stream-1' },
      {},
    );
    expect(mockGenerationJobManager.emitError).not.toHaveBeenCalled();
    expect(mockGenerationJobManager.markMainResponseComplete).not.toHaveBeenCalled();
  });

  test('a real provider failure is not superseded by another job generation or error wording', async () => {
    const req = makeReq();
    req.viventiumCallSession = { callSessionId: 'call-1' };
    req.body.viventiumVoiceTaskId = 'task-1';
    req.body.streamId = 'stream-1';
    mockGenerationJobManager.getJob.mockResolvedValue({ createdAt: 2, status: 'superseded' });
    const error = Object.assign(new Error('superseded provider request failed'), {
      code: 'provider_failure',
    });
    const client = makeClient(Promise.resolve());
    client.sendMessage.mockRejectedValueOnce(error);
    await AgentController(req, makeRes(), jest.fn(), async () => ({ client }), jest.fn());
    await jest.advanceTimersByTimeAsync(120);
    expect(mockSettleVoiceTaskGeneration).toHaveBeenCalledWith(
      'task-1',
      { userId: 'user-1', callSessionId: 'call-1', streamId: 'stream-1' },
      { error },
    );
    expect(mockGenerationJobManager.emitError).toHaveBeenCalledWith(
      'stream-1',
      'Viventium could not complete this request. Please try again.',
      'completion_error',
    );
  });

  /* === VIVENTIUM END === */

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

  test('an external adapter turn schedules Main compaction when its acceptance commits', async () => {
    const req = makeReq();
    setTrustedInteractionContext(
      req,
      {
        actor_kind: 'external_user',
        origin: 'interactive',
        surface: 'telegram',
        conversation_id: 'conv-1',
        revision: 1,
        source_event_id: 'telegram-update-7',
      },
      { segment_stability: 'immediate', supersede_scope: 'response_and_authoring' },
      { commit_authority: 'external_adapter' },
    );
    const identity = Object.freeze({
      ownerId: req.user.id,
      agentId: 'agent',
      stableAuthoritySha256: 'a'.repeat(64),
    });
    Object.defineProperty(req, '_viventiumAcceptedMainCompactionIdentityV1', { value: identity });
    const client = makeClient(Promise.resolve());
    client.options.agent = { id: 'agent' };
    await AgentController(
      req,
      makeRes(),
      jest.fn(),
      jest.fn(async () => ({ client })),
      jest.fn(),
    );
    await jest.advanceTimersByTimeAsync(120);
    await Promise.resolve();
    // Delivery is still provisional: nothing is accepted, so nothing is compacted yet.
    expect(mockEnsureAcceptedMainCompaction).not.toHaveBeenCalled();

    const { scheduleExternallyAcceptedMainCompaction } = require('@librechat/api');
    expect(
      scheduleExternallyAcceptedMainCompaction(
        { userId: req.user.id, responseMessageId: 'resp-msg-1' },
        { status: 'committed' },
      ),
    ).toBe(true);
    expect(mockEnsureAcceptedMainCompaction).toHaveBeenCalledTimes(1);
    expect(mockEnsureAcceptedMainCompaction).toHaveBeenCalledWith(
      expect.objectContaining({
        ...identity,
        trigger: 'accepted_turn',
        req,
        agent: client.options.agent,
      }),
    );
  });

  test('an externally delivered graph prepares its writer before FINAL and admits it once after acceptance', async () => {
    const req = makeReq();
    setTrustedInteractionContext(
      req,
      {
        actor_kind: 'external_user',
        origin: 'interactive',
        surface: 'telegram',
        conversation_id: 'conv-1',
        revision: 1,
        source_event_id: 'telegram-graph-source',
      },
      { segment_stability: 'immediate', supersede_scope: 'response_and_authoring' },
      { commit_authority: 'external_adapter' },
    );
    Object.defineProperty(req, '_viventiumAcceptedMainCompactionIdentityV1', {
      value: {
        ownerId: req.user.id,
        agentId: 'agent',
        stableAuthoritySha256: 'a'.repeat(64),
      },
    });
    req._viventiumNativeResponseIdentity = { invocationId: 'unsupported-graph' };
    mockRecoverSavedNativeResponse.mockResolvedValueOnce(null);
    mockGetNativeResponse.mockResolvedValueOnce({ nativeResponse: { status: 'unsupported' } });
    const client = makeClient(Promise.resolve());
    client.options.agent = { id: 'agent' };
    client.prepareDeferredMemoryWriter = jest.fn(() => true);
    client.startDeferredMemoryWriter = jest.fn(async () => true);
    client.admitMemoryWriter = jest.fn(async () => true);
    await AgentController(req, makeRes(), jest.fn(), async () => ({ client }), jest.fn());
    await jest.advanceTimersByTimeAsync(120);
    expect(client.prepareDeferredMemoryWriter).toHaveBeenCalledTimes(1);
    expect(client.startDeferredMemoryWriter).not.toHaveBeenCalled();
    expect(client.admitMemoryWriter).not.toHaveBeenCalled();
    expect(mockGenerationJobManager.emitDone).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ memoryWriterScheduled: true }),
    );
    // Disposal happens before the authenticated adapter ACK. Both captured follow-ups survive it.
    client.options = null;
    const { scheduleExternallyAcceptedMainCompaction } = require('@librechat/api');
    const presentation = { userId: req.user.id, responseMessageId: 'resp-msg-1' };
    for (const status of ['failed', 'partial', 'removed']) {
      expect(scheduleExternallyAcceptedMainCompaction(presentation, { status })).toBe(false);
    }
    expect(
      scheduleExternallyAcceptedMainCompaction(
        { ...presentation, userId: 'foreign' },
        { status: 'committed' },
      ),
    ).toBe(false);
    expect(scheduleExternallyAcceptedMainCompaction(presentation, { status: 'committed' })).toBe(
      true,
    );
    await Promise.resolve();
    expect(client.admitMemoryWriter).toHaveBeenCalledTimes(1);
    expect(mockEnsureAcceptedMainCompaction).toHaveBeenCalledTimes(1);
    expect(
      scheduleExternallyAcceptedMainCompaction(presentation, { status: 'already_committed' }),
    ).toBe(false);
    expect(client.admitMemoryWriter).toHaveBeenCalledTimes(1);
  });

  test.each(['server', 'external_adapter'])(
    'R15 native FINAL precedes memory graph preparation and accepted admission (%s)',
    async (authority) => {
      const req = makeReq();
      setTrustedInteractionContext(
        req,
        {
          actor_kind: 'external_user',
          origin: 'interactive',
          surface: authority === 'server' ? 'web' : 'telegram',
          conversation_id: 'conv-1',
          revision: 1,
          source_event_id: 'native-memory-source',
        },
        { segment_stability: 'immediate', supersede_scope: 'response_and_authoring' },
        { commit_authority: authority },
      );
      req._viventiumNativeResponseIdentity = { invocationId: 'native-memory' };
      const presentation = { userId: req.user.id, responseMessageId: 'resp-msg-1' };
      mockGenerationJobManager.acknowledgeStreamDelivery.mockResolvedValue({
        status: 'recorded',
        presentation,
      });
      let finishPreparation;
      const graphPreparation = new Promise((resolve) => {
        finishPreparation = resolve;
      });
      const client = makeClient(Promise.resolve());
      client.prepareDeferredMemoryWriter = jest.fn(() => true);
      client.startDeferredMemoryWriter = jest.fn(() => graphPreparation);
      client.admitMemoryWriter = jest.fn(() => graphPreparation);
      await AgentController(req, makeRes(), jest.fn(), async () => ({ client }), jest.fn());
      await jest.advanceTimersByTimeAsync(120);
      expect(mockGenerationJobManager.finishNativeResponse).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ memoryWriterScheduled: true }),
      );
      expect(client.prepareDeferredMemoryWriter).toHaveBeenCalledTimes(1);
      expect(client.startDeferredMemoryWriter).not.toHaveBeenCalled();
      if (authority === 'server') {
        expect(mockCommitAcceptedMainTurn).toHaveBeenCalled();
        expect(client.admitMemoryWriter).toHaveBeenCalledTimes(1);
        expect(
          mockGenerationJobManager.finishNativeResponse.mock.invocationCallOrder[0],
        ).toBeLessThan(client.admitMemoryWriter.mock.invocationCallOrder[0]);
      } else {
        expect(client.admitMemoryWriter).not.toHaveBeenCalled();
        client.options = null;
        const { scheduleExternallyAcceptedMainCompaction } = require('@librechat/api');
        expect(scheduleExternallyAcceptedMainCompaction(presentation, { status: 'partial' })).toBe(
          false,
        );
        expect(
          scheduleExternallyAcceptedMainCompaction(
            { ...presentation, userId: 'foreign' },
            { status: 'committed' },
          ),
        ).toBe(false);
        expect(
          scheduleExternallyAcceptedMainCompaction(presentation, { status: 'committed' }),
        ).toBe(true);
        await Promise.resolve();
        expect(client.admitMemoryWriter).toHaveBeenCalledTimes(1);
        expect(
          scheduleExternallyAcceptedMainCompaction(presentation, { status: 'already_committed' }),
        ).toBe(false);
      }
      finishPreparation(true);
      await Promise.resolve();
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
      $nor: [
        {
          'nativeResponse.status': 'cancelled',
          'nativeResponse.stopSnapshotStoredAt': { $gt: 0 },
        },
      ],
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

  test.each(['matching', 'other-conversation', 'other-turn', 'not-older', 'missing-user'])(
    'retracting a response preserves only its proven incoming user chain: %s',
    async (change) => {
      const req = makeReq();
      req.body.parentMessageId = 'response-b';
      setTrustedInteractionContext(
        req,
        {
          actor_kind: 'external_user',
          origin: 'interactive',
          surface: 'telegram',
          conversation_id: 'conv-1',
          logical_turn_id: 'logical',
          revision: 2,
          source_event_id: 'second-segment',
        },
        { segment_stability: 'immediate', supersede_scope: 'response_only' },
        { commit_authority: 'external_adapter' },
      );
      const interactionContext = getTrustedInteractionContext(req);
      mockGenerationJobManager.createJob.mockResolvedValueOnce({
        createdAt: 2,
        abortController: { signal: { aborted: false }, abort: jest.fn() },
        readyPromise: Promise.resolve(),
        emitter: new EventEmitter(),
        metadata: { interactionContext },
        supersededPresentations: [
          {
            conversationId: change === 'other-conversation' ? 'other' : 'conv-1',
            responseMessageId: 'response-b',
            userMessageId: change === 'missing-user' ? undefined : 'user-a',
            interactionContext: {
              logical_turn_id: change === 'other-turn' ? 'other' : 'logical',
              revision: change === 'not-older' ? 2 : 1,
            },
          },
        ],
      });
      const client = makeClient(Promise.resolve());
      await AgentController(
        req,
        makeRes(),
        jest.fn(),
        jest.fn(async () => ({ client })),
        jest.fn(),
      );
      await jest.advanceTimersByTimeAsync(120);
      const expectedParent = change === 'matching' ? 'user-a' : 'response-b';
      expect(req.body.parentMessageId).toBe(expectedParent);
      expect(client.sendMessage).toHaveBeenCalledWith(
        'hello',
        expect.objectContaining({ parentMessageId: expectedParent }),
      );
    },
  );

  test.each([
    ['Telegram audio with a versioned disposition provider', true, 'telegram'],
    ['Telegram text', false, 'telegram'],
    ['authenticated voice audio', true, 'voice'],
    ['untrusted voice audio flag', false, 'voice-untrusted'],
  ])(
    'binds the adapter input to its stream before a %s started receipt',
    async (_mode, dispositionRequired, surface) => {
      const req = makeReq();
      if (surface === 'telegram') {
        req._viventiumTelegram = true;
        req.body.telegramAudioRequested = dispositionRequired;
      } else {
        req.body.voiceMode = true;
        if (surface === 'voice') req.viventiumCallSession = { callSessionId: 'synthetic-call' };
      }
      req.body.endpointOption.agent = { provider: 'disposition-provider' };
      req.config = {
        endpoints: {
          agents: {
            providerCapabilities: {
              'disposition-provider': {
                messaging_delivery_disposition: true,
                messaging_delivery_disposition_version: 1,
              },
            },
          },
        },
      };
      const order = [];
      req._viventiumBeforeGenerationReceipt = jest.fn(async () => {
        order.push('bind');
      });
      const res = makeRes();
      res.json.mockImplementation(() => {
        order.push('started');
      });

      await AgentController(
        req,
        res,
        jest.fn(),
        jest.fn(async () => ({ client: makeClient(Promise.resolve()) })),
        jest.fn(),
      );

      const [streamId] = mockGenerationJobManager.createJob.mock.calls[0];
      expect(req._viventiumBeforeGenerationReceipt).toHaveBeenCalledWith({
        streamId,
        conversationId: 'conv-1',
      });
      expect(order.slice(0, 2)).toEqual(['bind', 'started']);
      const started = res.json.mock.calls[0][0];
      expect(started).toMatchObject({ streamId, status: 'started' });
      // The started receipt carries the same typed delivery contract a duplicate receipt carries.
      expect(started.deliveryDispositionRequired).toBe(dispositionRequired ? true : undefined);
    },
  );

  /* === VIVENTIUM START ===
   * Purpose: a revision becomes its sources' author just before its input binds to the stream,
   * after every step that can fail, and gives the authorship back if that binding fails.
   * === VIVENTIUM END === */
  test('commits authorship before binding the adapter input and gives it back when binding fails', async () => {
    const order = [];
    mockGenerationJobManager.commitLogicalTurnAuthor.mockImplementation(async () => {
      order.push('author');
    });
    mockGenerationJobManager.relinquishLogicalTurnAuthor.mockImplementation(async () => {
      order.push('relinquish');
    });
    const initialize = jest.fn(async () => ({ client: makeClient(Promise.resolve()) }));
    const req = makeReq();
    req._viventiumBeforeGenerationReceipt = jest.fn(async () => {
      order.push('bind');
    });
    const res = makeRes();
    res.json.mockImplementation(() => {
      order.push('started');
    });
    await AgentController(req, res, jest.fn(), initialize, jest.fn());
    const [streamId, userId] = mockGenerationJobManager.createJob.mock.calls[0];
    expect(mockGenerationJobManager.commitLogicalTurnAuthor).toHaveBeenCalledWith(streamId, userId);
    expect(order.slice(0, 3)).toEqual(['author', 'bind', 'started']);

    order.length = 0;
    const failing = makeReq();
    failing._viventiumBeforeGenerationReceipt = jest.fn(async () => {
      order.push('bind');
      throw new Error('input binding failed');
    });
    await AgentController(failing, makeRes(), jest.fn(), initialize, jest.fn());
    expect(order).toEqual(['author', 'bind', 'relinquish']);
    expect(mockGenerationJobManager.relinquishLogicalTurnAuthor).toHaveBeenCalledWith(
      mockGenerationJobManager.createJob.mock.calls[1][0],
      userId,
    );
  });
  /* === VIVENTIUM END === */

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
    expect(req._viventiumBeforeGenerationReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        streamId: originalStreamId,
        conversationId: originalConversationId,
        duplicate: true,
      }),
    );
    expect(req._viventiumBeforeGenerationReceipt.mock.invocationCallOrder[0]).toBeLessThan(
      res.json.mock.invocationCallOrder[0],
    );
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
    expect(preserved).toEqual({
      _id: 'saved-owner-turn',
      messageId: 'owner-turn',
      text: 'please research this',
      isCreatedByUser: true,
    });
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
  test('original Web receipt precedes awaited admission and does not use preparation completion time', async () => {
    const clock = jest.spyOn(Date, 'now').mockReturnValue(1000);
    const admission = deferred();
    mockCheckAndIncrementPendingRequest.mockImplementationOnce(() => admission.promise);
    const req = makeReq();
    req.body.streamId = 'stream-1';
    mockGenerationJobManager.createJob.mockResolvedValue({
      streamId: 'stream-1',
      abortController: new AbortController(),
      emitter: new EventEmitter(),
    });
    const request = AgentController(
      req,
      makeRes(),
      jest.fn(),
      jest.fn(async () => {
        throw new Error('Synthetic initialization stop');
      }),
      jest.fn(),
    );
    await Promise.resolve();
    clock.mockReturnValue(5000);
    admission.resolve({ allowed: true, pendingRequests: 0, limit: 10 });
    try {
      await request;
      const context =
        require('~/server/services/viventium/interactionContext').getTrustedInteractionContext(req);
      expect(context.source_received_at).toBe(1000);
      expect(context.source_segments[0].source_received_at).toBe(1000);
    } finally {
      clock.mockRestore();
    }
  });

  test.each([
    ['new', null, 2000],
    [
      'retained',
      {
        metadata: {
          viventium: { originalInputReceipt: { sourceEventId: 'source-a', receivedAt: 1000 } },
        },
      },
      1000,
    ],
    ['legacy', {}, undefined],
  ])(
    'preserves server original input receipt for %s without re-admission backfill',
    async (_name, original, expected) => {
      const req = makeReq();
      req.body.metadata = {
        viventium: { originalInputReceipt: { sourceEventId: 'source-a', receivedAt: 999999 } },
      };
      setTrustedInteractionContext(req, {
        actor_kind: 'external_user',
        origin: 'interactive',
        surface: 'telegram',
        conversation_id: 'conv-1',
        source_event_id: 'source-a',
        source_received_at: 2000,
      });
      mockOriginalMessage.mockImplementationOnce(async () => original);
      const result = await AgentController.captureAcceptedInteractionInput(req, {
        conversationId: 'conv-1',
        text: 'Owner reply',
      });
      expect(mockOriginalMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          user: req.user.id,
          conversationId: 'conv-1',
          isCreatedByUser: true,
        }),
      );
      expect(result.source_received_at).toBe(expected);
      expect(result.source_segments[0].source_received_at).toBe(expected);
      if (original) expect(mockSaveMessage).not.toHaveBeenCalled();
      else
        expect(mockSaveMessage.mock.calls[0][1].metadata.viventium.originalInputReceipt).toEqual({
          sourceEventId: 'source-a',
          receivedAt: 2000,
        });
      mockOriginalMessage.mockReset();
    },
  );

  beforeEach(() => {
    jest.clearAllMocks();
    mockMessageExists.mockResolvedValue(false);
    mockSaveMessage.mockResolvedValue({});
  });
  const trusted = (req, event) =>
    setTrustedInteractionContext(req, {
      actor_kind: 'external_user',
      origin: 'interactive',
      surface: 'telegram',
      conversation_id: 'conv-1',
      source_event_id: event,
      source_order_scope: 'a'.repeat(64),
      source_sequence: event === 'source-a' ? 1 : 2,
    });
  test('retains source before the slow save and marks it ready only after the raw save', async () => {
    const req = makeReq();
    trusted(req, 'source-a');
    const saved = deferred();
    mockSaveMessage.mockImplementationOnce(() => saved.promise);
    const capture = AgentController.captureAcceptedInteractionInput(req, {
      conversationId: 'conv-1',
      streamId: 'a-stream',
      text: 'First full goal',
      parentMessageId: 'base',
    });
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(mockGenerationJobManager.retainLogicalTurnInput).toHaveBeenCalledTimes(2);
    expect(
      mockGenerationJobManager.retainLogicalTurnInput.mock.calls[0][1].source_segments[0],
    ).toMatchObject({
      text: 'First full goal',
      source_sequence: 1,
      source_parent_message_id: 'base',
    });
    expect(
      mockGenerationJobManager.retainLogicalTurnInput.mock.calls[0][1].source_segments[0]
        .source_persisted,
    ).toBeUndefined();
    saved.resolve({});
    await capture;
    expect(mockGenerationJobManager.retainLogicalTurnInput).toHaveBeenCalledTimes(2);
    await AgentController.__testables.captureRequestInteractionContext(req, {
      conversationId: 'conv-1',
      streamId: 'a-stream',
    });
    expect(
      mockGenerationJobManager.retainLogicalTurnInput.mock.calls[2][1].source_segments[0]
        .source_persisted,
    ).toBe(true);
  });
  test('unresolved ingress does not reuse pending input across an explicit reset', async () => {
    const first = makeReq();
    trusted(first, 'source-a');
    await AgentController.retainAcceptedInteractionInput(first, {
      conversationId: 'new',
      text: 'First goal',
    });
    expect(mockGenerationJobManager.retainLogicalTurnInput).not.toHaveBeenCalled();
    const firstId = AgentController.__testables.resolveCanonicalConversationId(
      first,
      first.user.id,
      'new',
    );
    const reset = makeReq();
    trusted(reset, 'source-b');
    await AgentController.retainAcceptedInteractionInput(reset, {
      conversationId: 'new',
      text: 'After reset',
    });
    expect(mockGenerationJobManager.retainLogicalTurnInput).not.toHaveBeenCalled();
    const resetId = AgentController.__testables.resolveCanonicalConversationId(
      reset,
      reset.user.id,
      'new',
    );
    expect(resetId).not.toBe(firstId);
  });
  test('uses one canonical fresh conversation before the adapter replaces its request body', async () => {
    const req = makeReq();
    trusted(req, 'source-a');
    const early = await AgentController.captureAcceptedInteractionInput(req, {
      conversationId: 'new',
      streamId: 'a-stream',
      text: 'First goal',
      parentMessageId: null,
    });
    const canonical = AgentController.resolveCanonicalConversationId(req, req.user.id, 'new');
    expect(early.conversation_id).toBe(canonical);
    expect(AgentController.acceptedInteractionSourceId(req)).toBe(
      mockSaveMessage.mock.calls[0][1].messageId,
    );
    expect(mockSaveMessage).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        conversationId: canonical,
        parentMessageId: '00000000-0000-0000-0000-000000000000',
      }),
      expect.any(Object),
    );
  });
  test('a resolver reset cannot restore an existing rejected conversation', async () => {
    const req = makeReq();
    trusted(req, 'source-a');
    await AgentController.retainAcceptedInteractionInput(req, {
      conversationId: 'rejected-existing-conversation',
      text: 'Own user goal',
    });
    const resolved = await AgentController.captureAcceptedInteractionInput(req, {
      conversationId: 'new',
      parentMessageId: null,
    });
    expect(resolved.conversation_id).not.toBe('rejected-existing-conversation');
    expect(resolved.conversation_id).not.toBe('new');
    expect(mockSaveMessage).toHaveBeenCalledWith(
      req,
      expect.objectContaining({ conversationId: resolved.conversation_id, text: 'Own user goal' }),
      expect.any(Object),
    );
    expect(
      mockSaveMessage.mock.calls.every(
        ([, message]) => message.conversationId !== 'rejected-existing-conversation',
      ),
    ).toBe(true);
    req.body = { ...req.body, conversationId: resolved.conversation_id };
    expect(
      AgentController.__testables.resolveCanonicalConversationId(
        req,
        req.user.id,
        req.body.conversationId,
      ),
    ).toBe(resolved.conversation_id);
  });
  test('stale initialization sends the existing supersession receipt without initializing or cancelling work', async () => {
    const req = makeReq();
    req.viventiumCallSession = { callSessionId: 'call-1' };
    req.body.viventiumVoiceTaskId = 'task-1';
    req.body.streamId = 'stream-1';
    trusted(req, 'source-a');
    const res = makeRes();
    const init = jest.fn();
    mockGenerationJobManager.createJob.mockRejectedValueOnce(
      Object.assign(new Error('newer source'), { code: 'source_order_superseded' }),
    );
    await AgentController(req, res, jest.fn(), init, jest.fn());
    expect(mockSaveMessage).toHaveBeenCalledWith(
      req,
      expect.objectContaining({ text: 'hello', isCreatedByUser: true }),
      expect.any(Object),
    );
    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json).toHaveBeenCalledWith({
      code: 'source_order_superseded',
      superseded: true,
      conversationId: 'conv-1',
    });
    expect(init).not.toHaveBeenCalled();
    expect(mockSettleVoiceTaskGeneration).toHaveBeenCalledWith(
      'task-1',
      { userId: 'user-1', callSessionId: 'call-1', streamId: 'stream-1' },
      {},
    );
    expect(mockGenerationJobManager.completeJob).not.toHaveBeenCalled();
  });
  test('a ready older input releases its preparation receipt when current Main is busy without cancelling work', async () => {
    const req = makeReq();
    trusted(req, 'source-a');
    const res = makeRes();
    const init = jest.fn();
    require('@librechat/api').bindReadyInputContinuation(req, 'original-input', 2);
    req._viventiumBeforeGenerationReceipt = jest.fn().mockResolvedValue(undefined);
    mockGenerationJobManager.createJob.mockRejectedValueOnce(
      Object.assign(new Error('Main is active'), { code: 'source_input_waiting' }),
    );
    await AgentController(req, res, jest.fn(), init, jest.fn());
    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json).toHaveBeenCalledWith({
      code: 'source_input_pending',
      pending: true,
      conversationId: 'conv-1',
    });
    expect(req._viventiumBeforeGenerationReceipt).toHaveBeenCalledWith({
      code: 'source_input_pending',
      pending: true,
      conversationId: 'conv-1',
    });
    expect(req._viventiumBeforeGenerationReceipt.mock.invocationCallOrder[0]).toBeLessThan(
      res.json.mock.invocationCallOrder[0],
    );
    expect(init).not.toHaveBeenCalled();
    expect(mockGenerationJobManager.completeJob).not.toHaveBeenCalled();
  });
  test('failed persistence keeps the source unready and the same source retry repairs it', async () => {
    const first = makeReq();
    trusted(first, 'source-a');
    mockSaveMessage.mockRejectedValueOnce(new Error('Mongo temporarily unavailable'));
    await expect(
      AgentController.__testables.captureRequestInteractionContext(first, {
        conversationId: 'conv-1',
        streamId: 'a-stream',
      }),
    ).rejects.toThrow('Mongo temporarily unavailable');
    expect(
      mockGenerationJobManager.retainLogicalTurnInput.mock.calls.every(
        ([, context]) => context.source_segments[0].source_persisted !== true,
      ),
    ).toBe(true);
    const originalId =
      mockGenerationJobManager.retainLogicalTurnInput.mock.calls[0][1].source_segments[0]
        .source_message_id;
    const retry = makeReq();
    trusted(retry, 'source-a');
    const repaired = await AgentController.__testables.captureRequestInteractionContext(retry, {
      conversationId: 'conv-1',
      streamId: 'retry-stream',
    });
    expect(repaired.source_segments[0]).toMatchObject({
      source_message_id: originalId,
      source_persisted: true,
      text: 'hello',
    });
  });
  test('pending source persistence returns a typed retryable status rather than starting partial context', async () => {
    const req = makeReq();
    trusted(req, 'source-b');
    const res = makeRes();
    const init = jest.fn();
    mockGenerationJobManager.createJob.mockRejectedValueOnce(
      Object.assign(new Error('Input persistence pending; retry'), {
        code: 'source_input_persistence_pending',
      }),
    );
    await AgentController(req, res, jest.fn(), init, jest.fn());
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'source_input_persistence_pending', retryable: true }),
    );
    expect(init).not.toHaveBeenCalled();
    expect(mockGenerationJobManager.completeJob).not.toHaveBeenCalled();
  });
  test('links only exact owner-scoped source messages in order for the normal history loader', async () => {
    const req = makeReq();
    trusted(req, 'source-c');
    await AgentController.__testables.linkAcceptedInteractionSources(req, {
      conversation_id: 'conv-1',
      source_event_id: 'source-c',
      source_segments: [
        { source_event_id: 'source-a', source_message_id: 'a', source_parent_message_id: 'base' },
        { source_event_id: 'source-b', source_message_id: 'b', source_parent_message_id: 'base' },
        { source_event_id: 'source-c', source_message_id: 'c', source_parent_message_id: 'base' },
      ],
    });
    const { Message } = require('~/db/models');
    expect(Message.updateOne).toHaveBeenNthCalledWith(
      1,
      {
        user: 'user-1',
        conversationId: 'conv-1',
        messageId: 'b',
        isCreatedByUser: true,
        parentMessageId: 'base',
        'metadata.viventium.interactionContext.source_event_id': 'source-b',
      },
      { $set: { parentMessageId: 'a' } },
    );
    expect(Message.updateOne).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        messageId: 'c',
        'metadata.viventium.interactionContext.source_event_id': 'source-c',
      }),
      { $set: { parentMessageId: 'b' } },
    );
    expect(req.body.parentMessageId).toBe('b');
  });
  test('one trusted generation shares fresh canonical identity across distinct source events', async () => {
    const { createTelegramInteractionContext } = require('@librechat/api');
    const make = (event, generation, requested = 'new', owner = 'user-1') => {
      const req = makeReq();
      req.user.id = owner;
      setTrustedInteractionContext(
        req,
        createTelegramInteractionContext({
          conversation_id: requested,
          source_event_id: event,
          source_order_scope: 'a'.repeat(64),
          source_sequence: event === 'a' ? 1 : 2,
          conversation_generation: generation,
        }),
      );
      return req;
    };
    const generation = 'b'.repeat(64);
    const a = make('a', generation),
      b = make('b', generation);
    const resolve = (req) =>
      AgentController.__testables.resolveCanonicalConversationId(req, req.user.id, 'new');
    expect(resolve(a)).toBe(resolve(b));
    expect(resolve(make('b', 'c'.repeat(64)))).not.toBe(resolve(a));
    expect(resolve(make('b', generation, 'new', 'other-owner'))).not.toBe(resolve(a));
    const expiredA = make('a', generation, 'previous-chat'),
      expiredB = make('b', generation, 'previous-chat');
    expect(resolve(expiredA)).toBe(resolve(expiredB));
    expect(resolve(expiredA)).not.toBe('previous-chat');
    expect(resolve(expiredA)).not.toBe(resolve(a));
  });
});

describe('Voice file delivery outcome', () => {
  const outcome = AgentController.__testables.voiceGenerationOutcome;
  const unavailable = { nativeOutputFile: { version: 1, status: 'unavailable' } };

  test.each([
    ['unavailable', [unavailable]],
    ['mixed', [{ file_id: 'delivered-file' }, unavailable]],
  ])('keeps the result and exposes the %s delivery failure', (_name, attachments) => {
    const response = { messageId: 'file-result', attachments };
    const before = JSON.stringify(response);
    expect(outcome(response)).toEqual({
      resultMessageId: 'file-result',
      deliveryError: { code: 'native_output_file_unavailable' },
    });
    expect(response.attachments).toBe(attachments);
    expect(JSON.stringify(response)).toBe(before);
  });

  test.each([
    undefined,
    [{ file_id: 'delivered-file' }],
    [{ nativeOutputFile: { version: 2, status: 'unavailable' } }],
    [{ nativeOutputFile: { version: 1, status: 'available' } }],
  ])('preserves normal completion for attachments %j', (attachments) => {
    expect(outcome({ messageId: 'file-result', attachments })).toEqual({
      resultMessageId: 'file-result',
    });
  });

  test('preserves the primary terminal failure when a file is also unavailable', () => {
    expect(
      outcome({
        messageId: 'file-result',
        attachments: [unavailable],
        content: [{ type: 'error', error_class: 'provider_timeout', error: 'Provider timed out.' }],
      }),
    ).toEqual({
      resultMessageId: 'file-result',
      error: { code: 'provider_timeout', message: 'Provider timed out.' },
    });
  });
});

describe('coalesced retained input ancestry', () => {
  const link = AgentController.__testables.linkAcceptedInteractionSources;
  const owner = { user: 'user-1', conversationId: 'conv-1' };
  function fixture() {
    const req = makeReq();
    req.body.parentMessageId = 'base';
    const context = {
      conversation_id: 'conv-1',
      logical_turn_id: 'fresh-turn',
      revision: 1,
      source_event_id: 'source-d',
      ready_input_continuation: { source_message_id: 'd', presentation_source_sequence: 4 },
      source_segments: ['b', 'c', 'd'].map((id) => ({
        source_event_id: `source-${id}`,
        source_message_id: id,
        source_parent_message_id: id === 'b' ? 'unpublished' : 'base',
        source_persisted: true,
        authoring_revision: 1,
      })),
    };
    const rows = [
      { ...owner, messageId: 'base', parentMessageId: '', isCreatedByUser: true, sender: 'User' },
      ...context.source_segments.map((source) => ({
        ...owner,
        messageId: source.source_message_id,
        parentMessageId: source.source_parent_message_id,
        isCreatedByUser: true,
        sender: 'User',
        metadata: {
          viventium: {
            interactionContext: { source_event_id: source.source_event_id },
            telegramInput: { state: 'ready', sourceEventId: source.source_event_id },
          },
        },
      })),
    ];
    mockSourceHistoryRows.mockResolvedValue(rows);
    return { req, context, rows };
  }
  beforeEach(() => {
    jest.clearAllMocks();
    mockMutateNativeResponseSources.mockImplementation(async (_filter, operation) => operation());
    require('~/db/models').Message.updateOne.mockResolvedValue({
      matchedCount: 1,
      modifiedCount: 1,
    });
  });
  test('uses the proven adapter base for the missing first source, then links every retained source in order', async () => {
    const { req, context } = fixture();
    const before = JSON.stringify(context);
    await link(req, context);
    const { Message } = require('~/db/models');
    expect(
      Message.updateOne.mock.calls.map(([filter, update]) => [
        filter.messageId,
        filter.parentMessageId,
        update.$set.parentMessageId,
      ]),
    ).toEqual([
      ['b', 'unpublished', 'base'],
      ['c', 'base', 'b'],
      ['d', 'base', 'c'],
    ]);
    expect(mockMutateNativeResponseSources).toHaveBeenCalledTimes(3);
    expect(
      mockMutateNativeResponseSources.mock.calls.every(
        ([filter]) =>
          filter.user === owner.user &&
          filter.conversationId === owner.conversationId &&
          filter.isCreatedByUser === true,
      ),
    ).toBe(true);
    expect(req.body.parentMessageId).toBe('c');
    expect(JSON.stringify(context)).toBe(before);
  });
  test('an ordinary live claim includes newly authored pending B/C before its current D input', async () => {
    const { req, context } = fixture();
    delete context.ready_input_continuation;
    await link(req, context);
    expect(
      require('~/db/models').Message.updateOne.mock.calls.map(([filter, update]) => [
        filter.messageId,
        update.$set.parentMessageId,
      ]),
    ).toEqual([
      ['b', 'base'],
      ['c', 'b'],
      ['d', 'c'],
    ]);
    expect(req.body.parentMessageId).toBe('c');
  });
  test.each([false, true])(
    'an already authored first source adds no history read to a successor claim (ready=%s)',
    async (ready) => {
      const { req, context, rows } = fixture();
      if (!ready) delete context.ready_input_continuation;
      context.revision = 2;
      context.source_segments[0].source_parent_message_id = 'base';
      context.source_segments[1].authoring_revision = 2;
      context.source_segments[2].authoring_revision = 2;
      rows[1].parentMessageId = 'base';
      rows[1].metadata.viventium.telegramInput.state = 'admitted';
      await link(req, context);
      expect(mockSourceHistoryRows).not.toHaveBeenCalled();
      expect(
        require('~/db/models').Message.updateOne.mock.calls.map(([filter]) => filter.messageId),
      ).toEqual(['c', 'd']);
    },
  );
  test('keeps a healthy original first parent and still includes the other pending inputs', async () => {
    const { req, context, rows } = fixture();
    rows.push({
      ...owner,
      messageId: 'unpublished',
      parentMessageId: 'base',
      isCreatedByUser: false,
    });
    await link(req, context);
    expect(
      require('~/db/models').Message.updateOne.mock.calls.map(([filter]) => filter.messageId),
    ).toEqual(['c', 'd']);
    expect(req.body.parentMessageId).toBe('c');
  });
  test.each([
    'missing base',
    'foreign base',
    'deleted base',
    'deleted ancestor',
    'current input base',
    'descendant base',
    'cycle',
    'admitted first input',
    'changed first source',
    'unpersisted ledger',
    'foreign first input',
  ])('does not invent an anchor when %s', async (mode) => {
    const { req, context, rows } = fixture();
    if (mode === 'missing base') rows.splice(0, 1);
    if (mode === 'foreign base') rows[0].user = 'other-owner';
    if (mode === 'deleted base') rows[0].deletedAt = new Date();
    if (mode === 'deleted ancestor') {
      rows[0].parentMessageId = 'deleted';
      rows.push({ ...owner, messageId: 'deleted', parentMessageId: '', deletedAt: new Date() });
    }
    if (mode === 'current input base') req.body.parentMessageId = 'c';
    if (mode === 'descendant base') rows[0].parentMessageId = 'c';
    if (mode === 'cycle') rows[0].parentMessageId = 'base';
    if (mode === 'admitted first input')
      rows[1].metadata.viventium.telegramInput.state = 'admitted';
    if (mode === 'changed first source') rows[1].parentMessageId = 'elsewhere';
    if (mode === 'unpersisted ledger') delete context.source_segments[0].source_persisted;
    if (mode === 'foreign first input') rows[1].user = 'other-owner';
    await expect(link(req, context)).rejects.toMatchObject({
      code: 'source_context_unavailable',
      status: 413,
    });
    expect(mockMutateNativeResponseSources).not.toHaveBeenCalled();
    expect(require('~/db/models').Message.updateOne).not.toHaveBeenCalled();
  });
  test('keeps an already repaired first anchor idempotent and still links the remaining inputs', async () => {
    const { req, context, rows } = fixture();
    rows[1].parentMessageId = 'base';
    await link(req, context);
    expect(
      require('~/db/models').Message.updateOne.mock.calls.map(([filter]) => filter.messageId),
    ).toEqual(['c', 'd']);
  });
  test('the normal history loader and protected carrier receive every original current source after linking', async () => {
    const { req, context, rows } = fixture();
    for (const row of rows) row.text = `Exact ${row.messageId} source.`;
    for (const source of context.source_segments) {
      source.source_index = 0;
      source.text = rows.find((row) => row.messageId === source.source_message_id).text;
    }
    const originalTexts = rows.map((row) => row.text);
    require('~/db/models').Message.updateOne.mockImplementation(async (filter, update) => {
      const row = rows.find(
        (candidate) =>
          candidate.messageId === filter.messageId &&
          candidate.parentMessageId === filter.parentMessageId,
      );
      if (!row) return { matchedCount: 0, modifiedCount: 0 };
      row.parentMessageId = update.$set.parentMessageId;
      return { matchedCount: 1, modifiedCount: 1 };
    });
    await link(req, context);
    const {
      captureMainContextSnapshot,
      traceMainHistoryAncestry,
    } = require('~/server/services/viventium/ViventiumMainContextService');
    const { formatMessage, formatAgentMessages } = require('@librechat/agents');
    const proof = traceMainHistoryAncestry({
      messages: rows,
      headId: req.body.parentMessageId,
      ownerId: 'user-1',
      conversationId: 'conv-1',
    });
    const visible = [
      ...proof.messageIds.map((id) => rows.find((row) => row.messageId === id)),
      rows.find((row) => row.messageId === 'd'),
    ];
    setTrustedInteractionContext(req, {
      ...context,
      actor_kind: 'external_user',
      origin: 'interactive',
      surface: 'telegram',
      logical_turn_id: 'fresh-turn',
      revision: 1,
      source_sequence: 4,
      source_order_scope: 'a'.repeat(64),
    });
    const snapshot = captureMainContextSnapshot(req, {
      agent: {
        id: 'main',
        model_parameters: { configuration: { defaultHeaders: { 'X-GlassHive-Agent-Id': 'main' } } },
      },
      visibleMessages: visible,
      messages: formatAgentMessages(
        visible.map((message) => ({ ...formatMessage({ message }), messageId: message.messageId })),
      ).messages,
      historyAncestry: proof,
      protectUnreconciledHistory: true,
      nativeBodyCarrier: true,
    });
    expect(
      snapshot.visibleMessageChain.filter((row) => row.current_input).map((row) => row.id),
    ).toEqual(['b', 'c', 'd']);
    expect(
      snapshot.visibleMessageChain.find((row) => row.id === 'base').current_input,
    ).toBeUndefined();
    expect(rows.map((row) => row.text)).toEqual(originalTexts);
  });
  test('a raced first-source update stays unavailable instead of claiming repaired ancestry', async () => {
    const { req, context } = fixture();
    require('~/db/models').Message.updateOne.mockResolvedValueOnce({
      matchedCount: 0,
      modifiedCount: 0,
    });
    await expect(link(req, context)).rejects.toMatchObject({
      code: 'source_context_unavailable',
      status: 413,
    });
    expect(require('~/db/models').Message.updateOne).toHaveBeenCalledTimes(1);
  });
  test('the existing native source fence can reject the repair before any history edit', async () => {
    const { req, context } = fixture();
    mockMutateNativeResponseSources.mockRejectedValueOnce(
      Object.assign(new Error('Native source cannot change'), { code: 'native_source_conflict' }),
    );
    await expect(link(req, context)).rejects.toMatchObject({ code: 'native_source_conflict' });
    expect(require('~/db/models').Message.updateOne).not.toHaveBeenCalled();
  });
});
