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
const mockConversationUpdateOne = jest.fn();

const mockGenerationJobManager = {
  createJob: jest.fn(),
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
  Message: { findOneAndDelete: (...args) => mockMessageFindOneAndDelete(...args) },
  Conversation: { updateOne: (...args) => mockConversationUpdateOne(...args) },
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
    delete process.env.VIVENTIUM_PHASE_B_STREAM_WAIT_MS;

    mockGenerationJobManager.createJob.mockResolvedValue({
      createdAt: 1,
      abortController: { signal: { aborted: false }, abort: jest.fn() },
      readyPromise: Promise.resolve(),
      emitter: new EventEmitter(),
    });
    mockGenerationJobManager.getJob.mockResolvedValue({ createdAt: 1 });
    mockGenerationJobManager.emitDone.mockResolvedValue(undefined);
    mockGenerationJobManager.completeJob.mockResolvedValue(undefined);
    mockGenerationJobManager.emitChunk.mockResolvedValue(undefined);
    mockIsVoiceTaskSuppressed.mockReturnValue(false);
    mockGenerationJobManager.updateMetadata.mockResolvedValue(undefined);
    mockGenerationJobManager.setContentParts.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
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
    expect(mockGenerationJobManager.completeJob).not.toHaveBeenCalled();

    phaseB.resolve();
    await jest.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(mockGenerationJobManager.completeJob).toHaveBeenCalledWith('conv-1');
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
    process.env.VIVENTIUM_PHASE_B_STREAM_WAIT_MS = '500';
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
