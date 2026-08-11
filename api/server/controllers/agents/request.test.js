const { EventEmitter } = require('events');

const mockDisposeClient = jest.fn();
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

const mockGenerationJobManager = {
  createJob: jest.fn(),
  markMainResponseComplete: jest.fn(),
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
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('@librechat/api', () => ({
  sendEvent: jest.fn(),
  getViolationInfo: jest.fn(() => ({ score: 0 })),
  GenerationJobManager: mockGenerationJobManager,
  decrementPendingRequest: (...args) => mockDecrementPendingRequest(...args),
  sanitizeFileForTransmit: (f) => f,
  sanitizeMessageForTransmit: (m) => m,
  checkAndIncrementPendingRequest: (...args) => mockCheckAndIncrementPendingRequest(...args),
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
  saveMessage: (...args) => mockSaveMessage(...args),
}));

jest.mock('~/db/models', () => ({
  Message: {
    exists: (...args) => mockMessageExists(...args),
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
}));

const AgentController = require('./request');
const {
  bindLogicalTurnContext,
  createSchedulerInteractionContext,
  setTrustedInteractionContext,
} = require('~/server/services/viventium/interactionContext');

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
    mockGenerationJobManager.acknowledgeStreamDelivery.mockResolvedValue({ status: 'recorded' });
    mockGenerationJobManager.emitChunk.mockResolvedValue(undefined);
    mockIsVoiceTaskSuppressed.mockReturnValue(false);
    mockGenerationJobManager.updateMetadata.mockResolvedValue(undefined);
    mockGenerationJobManager.setContentParts.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
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
      { context: 'interaction-context-test' },
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
