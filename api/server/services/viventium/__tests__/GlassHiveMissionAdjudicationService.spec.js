/* === VIVENTIUM START ===
 * Feature: Main-authored GlassHive mission adjudication tests.
 * === VIVENTIUM END === */

let mockUpdateOne;
let mockMessageUpdateOne;
let mockMessageFindOne;
let mockMessageFind;
let mockConversationFindOne;
let mockStoredMessages;
let mockFindOneAndUpdate;
let mockFindOne;
let mockFind;
let mockGetUserById;
let mockGetFeelingState;
let mockGetConvo;
let mockSaveConvo;
let mockGetAgent;
let mockGetAppConfig;
let mockCreateCortexFollowUpMessage;
let mockPrepareCortexFollowUpMessage;
let mockPersistPreparedCortexFollowUpMessage;
let mockRecordOutcome;
let mockEnqueueDelivery;
let mockRecordTraceDelivery;
let mockGetActiveCallSessionForConversation;
let mockDeferAfterCommit;
let mockTransactionSession;
let mockRunTransaction;
let mockPrepareMissionOutputFiles;
let mockExternalWorkFindOne;
let mockNewestAttentionEvidence;
let mockAttentionEvidenceRows;
let mockRunStateFence;

jest.mock('mongoose', () => {
  const actual = jest.requireActual('mongoose');
  return {
    ...actual,
    transactionAsyncLocalStorage: {
      getStore: () => (mockTransactionSession ? { session: mockTransactionSession } : null),
    },
    connection: {
      ...actual.connection,
      collection: (name) =>
        name === 'viventium_external_work'
          ? { findOne: (...args) => mockExternalWorkFindOne(...args) }
          : name === 'messages'
            ? {
                updateOne: (...args) => mockMessageUpdateOne(...args),
                findOne: (...args) => mockMessageFindOne(...args),
                find: (...args) => mockMessageFind(...args),
              }
            : name === 'conversations'
              ? { findOne: (...args) => mockConversationFindOne(...args) }
              : {
                  updateOne: (...args) => mockUpdateOne(...args),
                  findOneAndUpdate: (...args) => mockFindOneAndUpdate(...args),
                  findOne: (...args) => mockFindOne(...args),
                  find: (...args) => mockFind(...args),
                },
    },
  };
});

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  fenceGlassHiveTerminalCallbackAcceptedOperation: jest.fn().mockResolvedValue(true),
}));

jest.mock('~/models', () => ({
  getUserById: (...args) => mockGetUserById(...args),
  getFeelingState: (...args) => mockGetFeelingState(...args),
  getConvo: (...args) => mockGetConvo(...args),
  saveConvo: (...args) => mockSaveConvo(...args),
}));

jest.mock('~/models/Agent', () => ({
  getAgent: (...args) => mockGetAgent(...args),
}));

jest.mock('~/db/models', () => ({
  GlassHiveTerminalCallbackResult: {},
  ViventiumCortexInsightDelivery: {},
  ViventiumCortexInsightOutbox: {},
}));

jest.mock('~/server/services/Config', () => ({
  getAppConfig: (...args) => mockGetAppConfig(...args),
}));

jest.mock('~/server/services/viventium/BackgroundCortexFollowUpService', () => ({
  createCortexFollowUpMessage: (...args) => mockCreateCortexFollowUpMessage(...args),
  prepareCortexFollowUpMessage: (...args) => mockPrepareCortexFollowUpMessage(...args),
  persistPreparedCortexFollowUpMessage: (...args) =>
    mockPersistPreparedCortexFollowUpMessage(...args),
}));

jest.mock('../CallSessionService', () => ({
  getActiveCallSessionForConversation: (...args) =>
    mockGetActiveCallSessionForConversation(...args),
}));

jest.mock('../GlassHiveCallbackBindingService', () => ({
  fenceGlassHiveCallbackRunState: (...args) => mockRunStateFence(...args),
  recordGlassHiveAdjudicationOutcome: (...args) => mockRecordOutcome(...args),
  isGlassHiveWorkTerminalCallback: (body = {}) =>
    body.work_terminal === true &&
    ['completed', 'failed', 'cancelled'].includes(String(body.work_state || '').toLowerCase()),
}));

jest.mock('../GlassHiveCallbackDeliveryService', () => ({
  enqueueGlassHiveCallbackDelivery: (...args) => mockEnqueueDelivery(...args),
}));

jest.mock('../nativeOutputFiles', () => ({
  prepareMissionOutputFiles: (...args) => mockPrepareMissionOutputFiles(...args),
}));

jest.mock('../OrchestrationTraceLedgerService', () => ({
  recordOrchestrationTraceDelivery: (...args) => mockRecordTraceDelivery(...args),
}));

jest.mock('../GlassHiveTerminalCallbackTransaction', () => ({
  deferGlassHiveTerminalCallbackAfterCommit: (...args) => mockDeferAfterCommit(...args),
  runGlassHiveTerminalCallbackTransaction: (...args) => mockRunTransaction(...args),
}));

const {
  COALESCE_MS,
  clearAdjudicationTimersForTests,
  enqueueGlassHiveMissionAdjudication,
  flushGlassHiveMissionAdjudications,
  redriveLegacyDeletedOriginMissionAdjudications,
  reconcilePendingGlassHiveMissionAdjudications,
} = require('../GlassHiveMissionAdjudicationService');

function cursor(rows) {
  const value = {
    sort: jest.fn(() => value),
    limit: jest.fn(() => value),
    toArray: jest.fn().mockResolvedValue(rows),
  };
  return value;
}

function storeAuthoredMessage(input, message) {
  if (message?.messageId) {
    mockStoredMessages.push({
      user: input.req.user.id,
      conversationId: input.conversationId,
      messageId: message.messageId,
      isCreatedByUser: false,
      text: message.text,
      ...(message.attachments ? { attachments: message.attachments } : {}),
    });
  }
  return message;
}

function retainAuthoredFollowUp(evidence) {
  evidence.authoredAt ||= new Date('2026-08-28T05:02:26.000Z');
  storeAuthoredMessage(
    {
      req: { user: { id: evidence.ownerId } },
      conversationId: evidence.accountContinuationConversationId || evidence.conversationId,
    },
    { messageId: evidence.followUpMessageId, text: evidence.followUpText },
  );
}

function canonicalCallbackRef(value) {
  const crypto = require('crypto');
  return `callback_sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function row(overrides = {}) {
  return {
    _id: 'cb-1',
    evidenceId: 'cb-1',
    originRef: 'ghi-origin-1',
    workRef: 'gh-work-1',
    workerId: 'worker-1',
    runId: 'run-1',
    event: 'run.completed',
    workState: 'completed',
    workTerminal: true,
    callbackRef: canonicalCallbackRef('cb-1'),
    attemptNumber: 1,
    ownerId: 'user-1',
    conversationId: 'conversation-1',
    anchorMessageId: 'assistant-anchor',
    mainAgentId: 'main-agent',
    surface: 'telegram',
    destinations: [
      { surface: 'telegram', telegramChatId: 'chat-1', telegramUserId: 'telegram-user-1' },
    ],
    evidence: 'Verified synthetic result.',
    state: 'pending',
    attempts: 0,
    ...overrides,
  };
}

let feelingPromptFixtureDirectory;
let previousFeelingPromptBundle;
beforeAll(() => {
  const fs = require('fs');
  const path = require('path');
  const {
    buildPromptBundleFixture,
  } = require('../../../../../scripts/test-support/promptBundle.cjs');
  feelingPromptFixtureDirectory = fs.mkdtempSync(
    path.join(require('os').tmpdir(), 'mission-feelings-test-'),
  );
  const bundle = path.join(feelingPromptFixtureDirectory, 'bundle.json');
  fs.writeFileSync(
    bundle,
    JSON.stringify(
      buildPromptBundleFixture(
        path.resolve(__dirname, '../../../../../viventium/source_of_truth/prompts'),
      ),
    ),
  );
  previousFeelingPromptBundle = process.env.VIVENTIUM_PROMPT_BUNDLE_PATH;
  process.env.VIVENTIUM_PROMPT_BUNDLE_PATH = bundle;
});
afterAll(() => {
  if (previousFeelingPromptBundle === undefined) delete process.env.VIVENTIUM_PROMPT_BUNDLE_PATH;
  else process.env.VIVENTIUM_PROMPT_BUNDLE_PATH = previousFeelingPromptBundle;
  require('fs').rmSync(feelingPromptFixtureDirectory, { recursive: true, force: true });
});

describe('GlassHiveMissionAdjudicationService', () => {
  test('terminal mission pending27 releases only its claim and keeps evidence until Main final', async () => {
    const processingAt = new Date('2026-10-11T14:28:04Z');
    const pending = row({ attempts: 0 });
    const claimed = { ...pending, state: 'processing', attempts: 1, processingAt };
    mockFind.mockReturnValueOnce(cursor([pending]));
    mockFindOneAndUpdate.mockResolvedValueOnce(claimed);
    mockPrepareCortexFollowUpMessage.mockResolvedValueOnce({ currentMainPending: true });
    await expect(flushGlassHiveMissionAdjudications({ ownerId: 'user-1' })).resolves.toMatchObject({
      claimed: 1,
      visible: 0,
      silent: 0,
      failed: 0,
    });
    expect(mockUpdateOne).toHaveBeenCalledWith(
      { _id: 'cb-1', state: 'processing', attempts: 1, processingAt },
      {
        $set: { state: 'pending', updatedAt: expect.any(Date) },
        $unset: { processingAt: '' },
        $inc: { attempts: -1 },
      },
    );
    expect(mockPersistPreparedCortexFollowUpMessage).not.toHaveBeenCalled();
    expect(mockEnqueueDelivery).not.toHaveBeenCalled();
    expect(mockRecordOutcome).not.toHaveBeenCalled();
    // The exact same retained evidence is judged after Main is ready; it may be semantically NTA.
    mockFind.mockReturnValueOnce(cursor([pending]));
    mockFindOneAndUpdate.mockResolvedValueOnce(claimed);
    mockPrepareCortexFollowUpMessage.mockResolvedValueOnce({
      text: '',
      decision: {},
      followUpDecisionRecord: {
        generationFailed: false,
        forceVisibleFollowUp: false,
        llmResult: 'nta',
        selectedStrategy: 'no_response_suppressed',
      },
    });
    mockCreateCortexFollowUpMessage.mockResolvedValueOnce(null);
    await expect(flushGlassHiveMissionAdjudications({ ownerId: 'user-1' })).resolves.toMatchObject({
      silent: 1,
    });
  });

  test('Main replay during synthesis resumes the same pinned group immediately after claim release', async () => {
    jest.useFakeTimers();
    const service = require('../GlassHiveMissionAdjudicationService');
    const pending = row({
      adjudicationGroupId: `ghag_${'a'.repeat(32)}`,
      adjudicationGroupMemberIds: ['cb-1'],
      adjudicationGroupPinnedAt: new Date(),
    });
    mockFind.mockReturnValueOnce(cursor([pending])).mockReturnValueOnce(cursor([pending]));
    mockFindOneAndUpdate.mockResolvedValue({
      ...pending,
      state: 'processing',
      attempts: 1,
      processingAt: new Date(),
    });
    mockPrepareCortexFollowUpMessage
      .mockImplementationOnce(async () => {
        service.wakeGlassHiveMissionAdjudications({
          ownerId: 'user-1',
          conversationId: 'conversation-1',
        });
        return { currentMainPending: true };
      })
      .mockImplementationOnce(async () => {
        expect(mockUpdateOne).toHaveBeenCalledWith(
          expect.objectContaining({ state: 'processing', attempts: 1 }),
          expect.objectContaining({ $inc: { attempts: -1 } }),
        );
        return { prepared: true };
      });
    service.wakeGlassHiveMissionAdjudications({
      ownerId: 'user-1',
      conversationId: 'conversation-1',
    });
    await jest.advanceTimersByTimeAsync(0);
    expect(mockPrepareCortexFollowUpMessage).toHaveBeenCalledTimes(2);
    expect(mockEnqueueDelivery).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('Main replay before direct claim release wakes retained evidence after the early wake misses', async () => {
    jest.useFakeTimers();
    const service = require('../GlassHiveMissionAdjudicationService');
    const pending = row({
      adjudicationGroupId: `ghag_${'a'.repeat(32)}`,
      adjudicationGroupMemberIds: ['cb-1'],
      adjudicationGroupPinnedAt: new Date(),
    });
    mockFind
      .mockReturnValueOnce(cursor([pending]))
      .mockReturnValueOnce(cursor([]))
      .mockReturnValueOnce(cursor([pending]));
    mockFindOneAndUpdate.mockResolvedValue({
      ...pending,
      state: 'processing',
      attempts: 1,
      processingAt: new Date(),
    });
    const ready = jest.fn(async () => {
      expect(mockUpdateOne).toHaveBeenCalledWith(
        expect.objectContaining({ state: 'processing', attempts: 1 }),
        expect.objectContaining({ $inc: { attempts: -1 } }),
      );
      return true;
    });
    mockPrepareCortexFollowUpMessage.mockImplementationOnce(async () => {
      // Direct reconciliation does not occupy the scheduler's lane. The early wake sees
      // no pending row while this exact direct claim still owns it.
      service.wakeGlassHiveMissionAdjudications({
        ownerId: 'user-1',
        conversationId: 'conversation-1',
      });
      await jest.advanceTimersByTimeAsync(0);
      expect(mockFind).toHaveBeenCalledTimes(2);
      return { currentMainPending: true, currentMainReadyAfterRelease: ready };
    });
    await flushGlassHiveMissionAdjudications({ ownerId: 'user-1' });
    await jest.advanceTimersByTimeAsync(0);
    expect(ready).toHaveBeenCalledTimes(1);
    expect(mockPrepareCortexFollowUpMessage).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(0);
  });

  test.each(['direct', 'ready wake'])(
    'still-running Main does not poll after %s claim release',
    async (mode) => {
      jest.useFakeTimers();
      const pending = row({
        adjudicationGroupId: `ghag_${'a'.repeat(32)}`,
        adjudicationGroupMemberIds: ['cb-1'],
        adjudicationGroupPinnedAt: new Date(),
      });
      mockFind.mockReturnValueOnce(cursor([pending]));
      const ready = jest.fn().mockResolvedValue(false);
      mockPrepareCortexFollowUpMessage.mockResolvedValueOnce({
        currentMainPending: true,
        currentMainReadyAfterRelease: ready,
      });
      if (mode === 'direct') {
        await flushGlassHiveMissionAdjudications({ ownerId: 'user-1' });
      } else {
        require('../GlassHiveMissionAdjudicationService').wakeGlassHiveMissionAdjudications({
          ownerId: pending.ownerId,
          conversationId: pending.conversationId,
        });
        await jest.advanceTimersByTimeAsync(0);
      }
      expect(ready).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
      await jest.advanceTimersByTimeAsync(COALESCE_MS * 10);
      expect(mockPrepareCortexFollowUpMessage).toHaveBeenCalledTimes(1);
      expect(mockEnqueueDelivery).not.toHaveBeenCalled();
    },
  );

  beforeEach(() => {
    clearAdjudicationTimersForTests();
    mockUpdateOne = jest.fn().mockResolvedValue({ acknowledged: true });
    mockMessageUpdateOne = jest.fn().mockResolvedValue({ acknowledged: true, matchedCount: 1 });
    mockStoredMessages = [];
    const originMessages = ['conversation-1', 'conversation-a', 'conversation-b'].flatMap(
      (conversationId) =>
        ['assistant-anchor', 'anchor-1', 'anchor-2', 'assistant-anchor-newer'].map((messageId) => ({
          user: 'user-1',
          conversationId,
          messageId,
          isCreatedByUser: false,
        })),
    );
    mockMessageFind = jest.fn((filter) =>
      cursor(
        [...originMessages, ...mockStoredMessages].filter(
          (message) =>
            message.user === filter.user &&
            message.conversationId === filter.conversationId &&
            filter.messageId.$in.includes(message.messageId),
        ),
      ),
    );
    mockMessageFindOne = jest.fn(
      async (filter) =>
        mockStoredMessages.find((message) =>
          Object.entries(filter).every(([key, value]) => message[key] === value),
        ) || null,
    );
    mockFindOneAndUpdate = jest.fn(async (filter) => ({
      ...row({ _id: filter._id }),
      state: 'processing',
    }));
    mockConversationFindOne = jest.fn().mockResolvedValue(null);
    mockNewestAttentionEvidence = { _id: 'cb-1' };
    mockAttentionEvidenceRows = null;
    mockFindOne = jest.fn(async (filter, options) => {
      if (filter.event !== 'run.needs_input' || filter.workTerminal !== false) return null;
      if (!mockAttentionEvidenceRows) return mockNewestAttentionEvidence;
      return (
        mockAttentionEvidenceRows
          .filter((row) => Object.entries(filter).every(([key, value]) => row[key] === value))
          .sort((left, right) => {
            for (const [key, direction] of Object.entries(options?.sort || {})) {
              if (left[key] === right[key]) continue;
              if (left[key] == null) return 1;
              if (right[key] == null) return -1;
              return (left[key] > right[key] ? 1 : -1) * direction;
            }
            return 0;
          })[0] || null
      );
    });
    mockFind = jest.fn().mockReturnValue(cursor([]));
    mockGetUserById = jest.fn().mockResolvedValue({ id: 'user-1', role: 'USER' });
    mockGetFeelingState = jest.fn().mockResolvedValue(null);
    mockGetConvo = jest
      .fn()
      .mockResolvedValue({ conversationId: 'conversation-1', user: 'user-1' });
    mockSaveConvo = jest.fn().mockImplementation(async (_req, conversation) => conversation);
    mockGetAgent = jest.fn().mockResolvedValue({ id: 'main-agent', provider: 'openAI' });
    mockGetAppConfig = jest.fn().mockResolvedValue({ endpoints: { agents: {} } });
    mockCreateCortexFollowUpMessage = jest.fn().mockResolvedValue({
      messageId: 'follow-up-1',
      text: 'Main-authored synthetic follow-up.',
    });
    mockPrepareCortexFollowUpMessage = jest.fn().mockResolvedValue({ prepared: true });
    mockPersistPreparedCortexFollowUpMessage = jest.fn(async (input) =>
      storeAuthoredMessage(input, await mockCreateCortexFollowUpMessage(input)),
    );
    mockRecordOutcome = jest.fn().mockResolvedValue({});
    mockEnqueueDelivery = jest.fn().mockResolvedValue({ configured: 1, enqueued: 1 });
    mockRecordTraceDelivery = jest.fn().mockResolvedValue(null);
    mockGetActiveCallSessionForConversation = jest.fn().mockResolvedValue(null);
    mockDeferAfterCommit = jest.fn().mockReturnValue(false);
    mockTransactionSession = null;
    mockRunTransaction = (operation) => operation(null);
    mockPrepareMissionOutputFiles = jest.fn().mockResolvedValue([]);
    mockExternalWorkFindOne = jest.fn().mockResolvedValue({ _id: 'ghi-origin-1' });
    mockRunStateFence = jest.fn().mockResolvedValue(undefined);
  });

  test('accepts unbound needs_input as nonterminal Main evidence and never raw delivery', async () => {
    const input = {
      binding: {
        originRef: 'ghi-origin-1',
        ownerId: 'user-1',
        workRef: 'gh-work-1',
        conversationId: 'conversation-1',
        anchorMessageId: 'assistant-anchor',
        mainAgentId: 'main-agent',
      },
      body: {
        callback_id: 'cb-attention',
        event: 'run.needs_input',
        work_state: 'needs_input',
        work_terminal: false,
        worker_id: 'worker-1',
        run_id: 'run-1',
        failure_class: 'authorization_expired',
        failure_user_message: 'The authorized scope needs renewal.',
        callback_created_at: '2026-01-01T00:00:00.123456+00:00',
      },
    };
    const first = await enqueueGlassHiveMissionAdjudication(input);
    const second = await enqueueGlassHiveMissionAdjudication(input);
    expect(first._id).toBe(second._id);
    expect(first).toMatchObject({
      workTerminal: false,
      workState: 'needs_input',
      event: 'run.needs_input',
      evidence: input.body.failure_user_message,
      callbackCreatedAt: '2026-01-01T00:00:00.123456Z',
    });
    expect(first).not.toHaveProperty('terminalCallbackResultKey');
    expect(mockRunStateFence).toHaveBeenCalled();
    expect(mockExternalWorkFindOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: input.binding.originRef,
        ownerId: input.binding.ownerId,
        workRef: input.binding.workRef,
        workerId: 'worker-1',
        runId: 'run-1',
        externalState: 'needs_input',
      }),
      expect.any(Object),
    );
    expect(mockEnqueueDelivery).not.toHaveBeenCalled();
  });

  test.each(['foreign-owner', 'foreign-work', 'superseded-run', 'already-resolved'])(
    'rejects %s unbound attention before it becomes Main evidence',
    async (_case) => {
      mockExternalWorkFindOne.mockResolvedValue(null);
      await expect(
        enqueueGlassHiveMissionAdjudication({
          binding: {
            originRef: 'ghi-origin-1',
            ownerId: 'user-1',
            workRef: 'gh-work-1',
            conversationId: 'conversation-1',
            anchorMessageId: 'assistant-anchor',
            mainAgentId: 'main-agent',
          },
          body: {
            callback_id: 'cb-attention',
            event: 'run.needs_input',
            work_state: 'needs_input',
            work_terminal: false,
            worker_id: 'worker-1',
            run_id: 'run-1',
            message: 'Input needed.',
          },
        }),
      ).rejects.toMatchObject({ code: 'glasshive_mission_evidence_superseded' });
      expect(mockUpdateOne).not.toHaveBeenCalled();
      expect(mockPrepareCortexFollowUpMessage).not.toHaveBeenCalled();
    },
  );

  test.each([false, true])(
    'keeps native input and output-file evidence together (files=%s)',
    async (withFiles) => {
      const pending = {
        version: 1,
        kind: 'permission',
        requestId: 'request-1',
        requestFingerprint: 'a'.repeat(64),
        runId: 'run-1',
        attemptId: 'attempt-1',
        sessionId: 'session-1',
        expiresAt: '2099-01-01T00:00:00Z',
        state: 'pending',
        mode: 'form',
        runtimeName: 'native-runtime',
        message: 'Write result.svg Yes; No.',
        requestedSchema: {
          type: 'object',
          required: ['optionId'],
          properties: {
            optionId: {
              type: 'string',
              enum: ['allow-once', 'reject-once'],
              enumNames: ['Yes', 'No'],
              enumKinds: ['allow_once', 'reject_once'],
              description: 'Write result.svg',
            },
          },
        },
        ignoredSecret: 'must-not-be-projected',
      };
      const evidence = await enqueueGlassHiveMissionAdjudication({
        binding: {
          originRef: 'ghi-origin-1',
          ownerId: 'user-1',
          workRef: 'gh-work-1',
          conversationId: 'conversation-1',
          anchorMessageId: 'assistant-anchor',
          mainAgentId: 'main-agent',
        },
        body: {
          callback_id: 'cb-native-input',
          event: 'run.needs_input',
          work_state: 'needs_input',
          worker_id: 'worker-1',
          run_id: 'run-1',
          work_terminal: false,
          pending_native_input: pending,
          message: pending.message,
        },
      });
      expect(evidence.nativeInputContext).toMatchObject({
        requestId: pending.requestId,
        requestFingerprint: pending.requestFingerprint,
        operationTitle: 'Write result.svg',
        choices: [
          { value: 'allow-once', label: 'Yes', kind: 'allow_once' },
          { value: 'reject-once', label: 'No', kind: 'reject_once' },
        ],
      });
      expect(evidence.nativeInputContext).not.toHaveProperty('ignoredSecret');
      if (withFiles)
        evidence.outputFiles = {
          version: 1,
          run_id: 'run-1',
          files: [
            {
              filename: 'preview.svg',
              sha256: 'a'.repeat(64),
              download_url: 'https://files.example.test/preview.svg',
            },
          ],
        };
      mockNewestAttentionEvidence = { _id: evidence._id };
      mockFind.mockReturnValueOnce(cursor([evidence]));
      mockFindOneAndUpdate.mockResolvedValueOnce({ ...evidence, state: 'processing', attempts: 1 });
      mockPrepareCortexFollowUpMessage.mockResolvedValueOnce({
        text: 'May I save the badge file you requested?',
      });
      await expect(
        flushGlassHiveMissionAdjudications({ ownerId: 'user-1' }),
      ).resolves.toMatchObject({ visible: 1 });
      const insight = mockPrepareCortexFollowUpMessage.mock.calls[0][0].insightsData.insights[0];
      expect(insight.insight).toContain('Write result.svg');
      expect(insight.insight).toContain('allow-once');
      if (withFiles) {
        const prefix = JSON.parse(insight.insight.slice(0, insight.insight.indexOf('\n\n')));
        expect(prefix.output_files).toMatchObject({ files: evidence.outputFiles.files, count: 1 });
        expect(prefix.nativeInput).toMatchObject({
          requestId: pending.requestId,
          requestFingerprint: pending.requestFingerprint,
          choices: evidence.nativeInputContext.choices,
        });
      }
      expect(insight.insight).not.toContain('must-not-be-projected');
      expect(insight.authority).toMatchObject({
        kind: 'durable_work_callback',
        event: 'run.needs_input',
      });
      expect(mockEnqueueDelivery.mock.calls[0][0]).toMatchObject({
        body: { event: 'main.followup' },
        text: 'Main-authored synthetic follow-up.',
      });
    },
  );

  test('authors the blocker through Main and delivers authored text', async () => {
    const attention = row({
      event: 'run.needs_input',
      workState: 'needs_input',
      workTerminal: false,
      evidence: 'The authorized scope needs renewal.',
      callbackRef: 'callback_sha256:' + 'b'.repeat(64),
      evidenceId: 'ghe_' + 'a'.repeat(32),
    });
    mockFind.mockReturnValueOnce(cursor([attention]));
    mockFindOneAndUpdate.mockResolvedValueOnce({ ...attention, state: 'processing', attempts: 1 });
    mockPrepareCortexFollowUpMessage.mockResolvedValueOnce({
      text: 'I need your approval to continue. May I renew this access?',
    });
    await expect(flushGlassHiveMissionAdjudications({ ownerId: 'user-1' })).resolves.toMatchObject({
      visible: 1,
    });
    const input = mockPrepareCortexFollowUpMessage.mock.calls[0][0];
    expect(input.insightsData.insights[0].authority).toEqual({
      kind: 'durable_work_callback',
      userSource: { messageId: null, conversationId: 'conversation-1' },
      runId: 'run-1',
      event: 'run.needs_input',
      workState: 'needs_input',
    });
    expect(mockEnqueueDelivery.mock.calls[0][0]).toMatchObject({
      body: { event: 'main.followup' },
      text: 'Main-authored synthetic follow-up.',
    });
    expect(mockRunStateFence.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  test.each([true, false])(
    'nonterminal blocker uses the durable presentation only while Call is open (%s)',
    async (open) => {
      const attention = row({
        event: 'run.needs_input',
        workState: 'needs_input',
        workTerminal: false,
        attemptNumber: undefined,
        evidenceId: 'ghe_' + 'a'.repeat(32),
        surface: 'voice',
        destinations: [
          { surface: 'voice', voiceCallSessionId: 'old-call', voiceRequestId: 'old-turn' },
        ],
      });
      mockFind.mockReturnValueOnce(cursor([attention]));
      mockFindOneAndUpdate.mockResolvedValueOnce({
        ...attention,
        state: 'processing',
        attempts: 1,
      });
      mockGetActiveCallSessionForConversation.mockResolvedValue(
        open ? { callSessionId: 'current-call' } : null,
      );
      mockPrepareCortexFollowUpMessage.mockResolvedValueOnce({
        text: 'May I renew access to continue?',
      });
      await expect(
        flushGlassHiveMissionAdjudications({ ownerId: 'user-1' }),
      ).resolves.toMatchObject({ visible: 1 });
      const delivery = mockEnqueueDelivery.mock.calls[0][0];
      expect(delivery.message.messageId).toBe('follow-up-1');
      if (open) {
        expect(delivery.deliveryContext.workerCompletionPresentation.bindings).toEqual([
          {
            kind: 'nonterminal_attention',
            originRef: attention.originRef,
            workRef: attention.workRef,
            workerId: attention.workerId,
            runId: attention.runId,
            callbackRef: attention.callbackRef,
            event: 'run.needs_input',
            workTerminal: false,
            evidenceId: attention.evidenceId,
          },
        ]);
        expect(delivery.deliveryContext.destinations).toEqual([
          expect.objectContaining({
            surface: 'voice',
            voiceCallSessionId: 'current-call',
          }),
        ]);
      } else {
        expect(delivery.deliveryContext.destinations).toEqual([]);
        expect(delivery.deliveryContext).not.toHaveProperty('workerCompletionPresentation');
      }
    },
  );

  test('same-run re-entry excludes stale A before Main grouping and publishes only B', async () => {
    const older = row({
      _id: 'ghe_' + 'a'.repeat(32),
      evidenceId: 'ghe_' + 'a'.repeat(32),
      event: 'run.needs_input',
      workState: 'needs_input',
      workTerminal: false,
      callbackRef: canonicalCallbackRef('callback-A'),
      evidence: 'Old blocker A.',
    });
    const newer = {
      ...older,
      _id: 'ghe_' + 'b'.repeat(32),
      evidenceId: 'ghe_' + 'b'.repeat(32),
      callbackRef: canonicalCallbackRef('callback-B'),
      evidence: 'Current blocker B.',
    };
    mockNewestAttentionEvidence = { _id: newer._id };
    mockFind.mockReturnValueOnce(cursor([older, newer]));
    mockFindOneAndUpdate.mockResolvedValueOnce({ ...newer, state: 'processing', attempts: 1 });
    mockPrepareCortexFollowUpMessage.mockResolvedValueOnce({ text: 'Main asks about current B.' });
    await expect(flushGlassHiveMissionAdjudications({ ownerId: 'user-1' })).resolves.toMatchObject({
      claimed: 1,
      visible: 1,
      failed: 0,
    });
    expect(mockUpdateOne).toHaveBeenCalledWith(
      { _id: older._id, state: 'pending' },
      expect.objectContaining({ $set: expect.objectContaining({ state: 'superseded' }) }),
    );
    const insights = mockPrepareCortexFollowUpMessage.mock.calls[0][0].insightsData.insights;
    expect(insights.map((insight) => insight.insight)).toEqual(['Current blocker B.']);
    expect(mockPersistPreparedCortexFollowUpMessage).toHaveBeenCalledTimes(1);
    expect(mockEnqueueDelivery).toHaveBeenCalledTimes(1);
  });

  test('late old native A retry cannot supersede earlier-accepted B in Main publication', async () => {
    const older = row({
      _id: 'ghe_' + 'a'.repeat(32),
      evidenceId: 'ghe_' + 'a'.repeat(32),
      event: 'run.needs_input',
      workState: 'needs_input',
      workTerminal: false,
      callbackRef: canonicalCallbackRef('callback-A'),
      evidence: 'Old blocker A.',
      callbackCreatedAt: '2026-01-01T00:00:00.000001Z',
      createdAt: new Date('2026-01-01T00:03:00Z'),
    });
    const newer = {
      ...older,
      _id: 'ghe_' + 'b'.repeat(32),
      evidenceId: 'ghe_' + 'b'.repeat(32),
      callbackRef: canonicalCallbackRef('callback-B'),
      evidence: 'Current blocker B.',
      callbackCreatedAt: '2026-01-01T00:00:00.000002Z',
      createdAt: new Date('2026-01-01T00:02:00Z'),
    };
    mockAttentionEvidenceRows = [older, newer];
    mockFind.mockReturnValueOnce(cursor([newer, older]));
    mockFindOneAndUpdate.mockResolvedValueOnce({ ...newer, state: 'processing', attempts: 1 });
    mockPrepareCortexFollowUpMessage.mockResolvedValueOnce({ text: 'Main asks about current B.' });
    await expect(flushGlassHiveMissionAdjudications({ ownerId: 'user-1' })).resolves.toMatchObject({
      claimed: 1,
      visible: 1,
    });
    expect(
      mockPrepareCortexFollowUpMessage.mock.calls[0][0].insightsData.insights.map(
        (insight) => insight.insight,
      ),
    ).toEqual(['Current blocker B.']);
    expect(mockFindOne).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'user-1', runId: 'run-1' }),
      expect.objectContaining({ sort: { callbackCreatedAt: -1, _id: -1 } }),
    );
    expect(mockEnqueueDelivery).toHaveBeenCalledTimes(1);
  });

  test('newer same-run attention during Main synthesis fences the authored row before publication', async () => {
    const attention = row({
      event: 'run.needs_input',
      workState: 'needs_input',
      workTerminal: false,
    });
    mockFind.mockReturnValueOnce(cursor([attention]));
    mockFindOneAndUpdate.mockResolvedValueOnce({ ...attention, state: 'processing', attempts: 1 });
    mockPrepareCortexFollowUpMessage.mockImplementationOnce(async () => {
      mockNewestAttentionEvidence = { _id: 'newer-same-run-attention' };
      return { text: 'An old authored question.' };
    });
    await flushGlassHiveMissionAdjudications({ ownerId: 'user-1' });
    expect(mockPersistPreparedCortexFollowUpMessage).not.toHaveBeenCalled();
    expect(mockEnqueueDelivery).not.toHaveBeenCalled();
  });

  test('superseded attention after Main synthesis cannot publish a stale blocker', async () => {
    const attention = row({
      event: 'run.needs_input',
      workState: 'needs_input',
      workTerminal: false,
    });
    mockFind.mockReturnValueOnce(cursor([attention]));
    mockFindOneAndUpdate.mockResolvedValueOnce({ ...attention, state: 'processing', attempts: 1 });
    mockPrepareCortexFollowUpMessage.mockImplementationOnce(async () => {
      mockExternalWorkFindOne.mockResolvedValue(null);
      return { text: 'An authored question.' };
    });
    await flushGlassHiveMissionAdjudications({ ownerId: 'user-1' });
    expect(mockPersistPreparedCortexFollowUpMessage).not.toHaveBeenCalled();
    expect(mockEnqueueDelivery).not.toHaveBeenCalled();
  });

  test.each(['question', 'permission'])(
    'adjudicates an exact bound native %s through Main without executing its choice',
    async (kind) => {
      await expect(
        enqueueGlassHiveMissionAdjudication({
          binding: {
            originRef: 'ghi-origin-1',
            ownerId: 'user-1',
            conversationId: 'conversation-1',
            anchorMessageId: 'assistant-anchor',
            mainAgentId: 'main-agent',
          },
          body: {
            callback_id: 'cb_native_attention',
            worker_id: 'worker-1',
            event: 'run.needs_input',
            work_state: 'needs_input',
            run_id: 'run-1',
            work_terminal: false,
            pending_native_input: {
              version: 1,
              kind,
              requestId: 'request-1',
              requestFingerprint: 'a'.repeat(64),
              runId: 'run-1',
              attemptId: 'attempt-1',
              sessionId: 'session-1',
              expiresAt: '2099-01-01T00:00:00Z',
              state: 'pending',
              mode: 'form',
            },
            message: 'Native request.',
          },
        }),
      ).resolves.toMatchObject({
        event: 'run.needs_input',
        state: 'pending',
        evidence: 'Native request.',
      });
      expect(mockUpdateOne).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          $setOnInsert: expect.objectContaining({ event: 'run.needs_input', workTerminal: false }),
        }),
        expect.anything(),
      );
      expect(mockEnqueueDelivery).not.toHaveBeenCalled();
    },
  );

  test('carries only the trusted original user source into durable mission evidence', async () => {
    await enqueueGlassHiveMissionAdjudication({
      binding: {
        ownerId: 'user-1',
        conversationId: 'conversation-1',
        originRef: 'ghi-original',
        workRef: 'work-original',
        anchorMessageId: 'removed-anchor',
        requestedParentMessageId: 'original-user',
        mainAgentId: 'main-agent',
      },
      body: {
        callback_id: 'cb-source',
        event: 'run.completed',
        work_state: 'completed',
        work_terminal: true,
        worker_id: 'worker-1',
        run_id: 'run-1',
        message: 'Verified result.',
        requested_parent_message_id: 'untrusted-user',
      },
    });
    expect(mockUpdateOne.mock.calls[0][1].$setOnInsert).toMatchObject({
      anchorMessageId: 'removed-anchor',
      requestedParentMessageId: 'original-user',
    });
  });

  test('retains the correction and latest reply context after the original Main anchor was removed', async () => {
    const pending = row({
      anchorMessageId: 'removed-anchor',
      requestedParentMessageId: 'original-user',
    });
    const messages = [
      {
        user: 'user-1',
        conversationId: 'conversation-1',
        messageId: 'original-user',
        isCreatedByUser: true,
        text: 'Build both lessons.',
        createdAt: '2026-04-28T14:00:00.000Z',
      },
      {
        user: 'user-1',
        conversationId: 'conversation-1',
        messageId: 'correction-user',
        parentMessageId: 'original-user',
        isCreatedByUser: true,
        text: 'Use one quarter instead.',
        createdAt: '2026-04-28T14:00:01.000Z',
      },
      {
        user: 'user-1',
        conversationId: 'conversation-1',
        messageId: 'current-main',
        parentMessageId: 'correction-user',
        isCreatedByUser: false,
        text: 'I steered the probability lesson. The other lesson continues.',
        createdAt: '2026-04-28T14:00:02.000Z',
      },
    ];
    mockMessageFind.mockReturnValue(cursor(messages));
    mockFind.mockReturnValueOnce(cursor([pending]));
    mockFindOneAndUpdate.mockResolvedValueOnce({ ...pending, state: 'processing' });
    const real = jest.requireActual('../BackgroundCortexFollowUpService');
    mockPrepareCortexFollowUpMessage.mockImplementationOnce(async (input) => {
      const continuation = real.resolveFollowUpContinuationContext(messages, input.parentMessageId);
      expect(continuation.hasMovedOn).toBe(true);
      expect(continuation.contextText).toContain('Use one quarter instead.');
      expect(continuation.contextText).toContain('I steered the probability lesson.');
      expect(continuation.currentLeafMessageId).toBe('current-main');
      return { prepared: true };
    });
    await expect(flushGlassHiveMissionAdjudications({ ownerId: 'user-1' })).resolves.toMatchObject({
      visible: 1,
      failed: 0,
    });
    expect(mockPrepareCortexFollowUpMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        parentMessageId: 'original-user',
        deliveryParentMessageId: 'original-user',
      }),
    );
    expect(pending.anchorMessageId).toBe('removed-anchor');
  });

  test.each([
    ['missing', null],
    ['assistant', { user: 'user-1', conversationId: 'conversation-1', isCreatedByUser: false }],
    [
      'foreign owner',
      { user: 'other-user', conversationId: 'conversation-1', isCreatedByUser: true },
    ],
    [
      'foreign conversation',
      { user: 'user-1', conversationId: 'other-conversation', isCreatedByUser: true },
    ],
  ])('rejects a removed-anchor continuation whose source is %s', async (_label, source) => {
    const pending = row({
      anchorMessageId: 'removed-anchor',
      requestedParentMessageId: 'original-user',
    });
    mockMessageFind.mockReturnValue(
      cursor(source ? [{ messageId: 'original-user', ...source }] : []),
    );
    mockFind.mockReturnValueOnce(cursor([pending]));
    mockFindOneAndUpdate.mockResolvedValueOnce({ ...pending, state: 'processing' });
    await expect(flushGlassHiveMissionAdjudications({ ownerId: 'user-1' })).resolves.toMatchObject({
      visible: 0,
      failed: 1,
    });
    expect(mockPrepareCortexFollowUpMessage).not.toHaveBeenCalled();
    expect(mockPersistPreparedCortexFollowUpMessage).not.toHaveBeenCalled();
    expect(mockRecordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: 'mission_origin_source_unavailable',
      }),
    );
  });

  test('preserves source cleanup authority when the old Main anchor is absent', async () => {
    const pending = row({
      anchorMessageId: 'removed-anchor',
      requestedParentMessageId: 'original-user',
    });
    mockMessageFind.mockReturnValue(
      cursor([
        {
          messageId: 'original-user',
          user: 'user-1',
          conversationId: 'conversation-1',
          isCreatedByUser: true,
          deletedAt: new Date('2026-04-28T14:00:00.000Z'),
        },
      ]),
    );
    mockFind.mockReturnValueOnce(cursor([pending]));
    mockFindOneAndUpdate.mockResolvedValueOnce({ ...pending, state: 'processing' });
    await expect(flushGlassHiveMissionAdjudications({ ownerId: 'user-1' })).resolves.toMatchObject({
      visible: 0,
      silent: 1,
      failed: 0,
    });
    expect(mockPrepareCortexFollowUpMessage).not.toHaveBeenCalled();
    expect(mockRecordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'silent',
        errorCode: 'mission_origin_cleanup_tombstoned',
      }),
    );
  });

  afterEach(() => {
    clearAdjudicationTimersForTests();
    jest.useRealTimers();
  });

  test.each(['web', 'voice', 'telegram'])(
    'reads a fresh exact owner version for %s mission synthesis',
    async (surface) => {
      const { loadFeelingsReadContext, clearFeelingsReadCache } = require('@librechat/api');
      clearFeelingsReadCache('user-1');
      mockGetFeelingState.mockResolvedValueOnce({ enabled: true, version: 1 });
      await loadFeelingsReadContext({ userId: 'user-1', getFeelingState: mockGetFeelingState });
      mockGetFeelingState.mockResolvedValue({ enabled: true, version: 2 });
      const evidence = row({ surface });
      mockFind.mockReturnValueOnce(cursor([evidence]));
      mockFindOneAndUpdate.mockResolvedValueOnce({ ...evidence, state: 'processing' });
      await expect(
        flushGlassHiveMissionAdjudications({ ownerId: 'user-1' }),
      ).resolves.toMatchObject({ visible: 1, failed: 0 });
      const req = mockPrepareCortexFollowUpMessage.mock.calls[0][0].req;
      expect(mockGetFeelingState).toHaveBeenNthCalledWith(2, 'user-1');
      expect(req._viventiumFeelingSnapshot).toEqual(
        expect.objectContaining({ enabled: true, version: 2, cacheHit: false }),
      );
      expect(req._viventiumFeelingSnapshot.capsule).toContain('<viventium_feeling_state');
      expect(req._viventiumFeelingReadFailureClass).toBe('');
    },
  );

  test.each([undefined, false, true])(
    'retains explicit isolation %s while old rows remain ordinary',
    async (feelingsIsolated) => {
      mockGetFeelingState.mockResolvedValue({ enabled: true, version: 2 });
      const evidence = row({ feelingsIsolated });
      mockFind.mockReturnValueOnce(cursor([evidence]));
      mockFindOneAndUpdate.mockResolvedValueOnce({ ...evidence, state: 'processing' });
      await flushGlassHiveMissionAdjudications({ ownerId: 'user-1' });
      const req = mockPrepareCortexFollowUpMessage.mock.calls[0][0].req;
      if (feelingsIsolated === true) {
        expect(mockGetFeelingState).not.toHaveBeenCalled();
        expect(req._viventiumFeelingSnapshot).toBeNull();
        expect(req._viventiumFeelingReadFailureClass).toBe('temporary_eval_isolation');
      } else {
        expect(mockGetFeelingState).toHaveBeenCalledWith('user-1');
        expect(req._viventiumFeelingSnapshot.enabled).toBe(true);
      }
    },
  );

  test('does not attach affect when the current owner disables Feelings', async () => {
    mockGetFeelingState.mockResolvedValue({ enabled: false, version: 3 });
    mockFind.mockReturnValueOnce(cursor([row()]));
    await flushGlassHiveMissionAdjudications({ ownerId: 'user-1' });
    expect(mockPrepareCortexFollowUpMessage.mock.calls[0][0].req._viventiumFeelingSnapshot).toEqual(
      expect.objectContaining({ enabled: false, version: 3, capsule: '' }),
    );
  });

  test.each(['state_read_failed', 'state_read_timeout'])(
    'fails open to ordinary synthesis on %s',
    async (failureClass) => {
      const previous = process.env.VIVENTIUM_FEELINGS_READ_TIMEOUT_MS;
      process.env.VIVENTIUM_FEELINGS_READ_TIMEOUT_MS = '25';
      mockGetFeelingState =
        failureClass === 'state_read_timeout'
          ? jest.fn(() => new Promise(() => {}))
          : jest.fn().mockRejectedValue(new Error('synthetic read failure'));
      try {
        mockFind.mockReturnValueOnce(cursor([row()]));
        await expect(
          flushGlassHiveMissionAdjudications({ ownerId: 'user-1' }),
        ).resolves.toMatchObject({ visible: 1, failed: 0 });
        const req = mockPrepareCortexFollowUpMessage.mock.calls[0][0].req;
        expect(req._viventiumFeelingSnapshot).toBeNull();
        expect(req._viventiumFeelingReadFailureClass).toBe(failureClass);
      } finally {
        if (previous === undefined) delete process.env.VIVENTIUM_FEELINGS_READ_TIMEOUT_MS;
        else process.env.VIVENTIUM_FEELINGS_READ_TIMEOUT_MS = previous;
      }
    },
  );

  test('does not coalesce isolated and ordinary new callback consumers', async () => {
    mockGetFeelingState.mockResolvedValue({ enabled: true, version: 2 });
    const rows = [
      row({ feelingsIsolated: true }),
      row({
        _id: 'cb-2',
        evidenceId: 'cb-2',
        originRef: 'ghi-origin-2',
        anchorMessageId: 'anchor-2',
        feelingsIsolated: false,
      }),
    ];
    mockFind.mockReturnValueOnce(cursor(rows));
    mockFindOneAndUpdate.mockImplementation(async (filter) => ({
      ...rows.find((item) => item._id === filter._id),
      state: 'processing',
    }));
    await expect(flushGlassHiveMissionAdjudications({ ownerId: 'user-1' })).resolves.toMatchObject({
      groups: 2,
      failed: 0,
    });
    const requests = mockPrepareCortexFollowUpMessage.mock.calls.map(([input]) => input.req);
    expect(requests.filter((req) => req._viventiumFeelingSnapshot === null)).toHaveLength(1);
    expect(requests.filter((req) => req._viventiumFeelingSnapshot?.enabled === true)).toHaveLength(
      1,
    );
    expect(mockGetFeelingState).toHaveBeenCalledTimes(1);
  });

  test('fails open without owner affect for a persisted mixed isolation group', async () => {
    const groupId = `ghag_${'9'.repeat(32)}`;
    const members = ['cb-1', 'cb-2'];
    const pinned = {
      adjudicationGroupId: groupId,
      adjudicationGroupMemberIds: members,
      adjudicationGroupPinnedAt: new Date('2026-01-01T12:00:00.000Z'),
    };
    const rows = [
      row({ ...pinned, feelingsIsolated: true }),
      row({
        ...pinned,
        _id: 'cb-2',
        evidenceId: 'cb-2',
        originRef: 'ghi-origin-2',
        feelingsIsolated: false,
      }),
    ];
    mockFind.mockReturnValueOnce(cursor(rows));
    mockFindOneAndUpdate.mockImplementation(async (filter) => ({
      ...rows.find((item) => item._id === filter._id),
      state: 'processing',
    }));
    await expect(flushGlassHiveMissionAdjudications({ ownerId: 'user-1' })).resolves.toMatchObject({
      groups: 1,
      failed: 0,
    });
    expect(mockGetFeelingState).not.toHaveBeenCalled();
    expect(
      mockPrepareCortexFollowUpMessage.mock.calls[0][0].req._viventiumFeelingSnapshot,
    ).toBeNull();
  });

  test('persists isolation from its verified binding only', async () => {
    await enqueueGlassHiveMissionAdjudication({
      binding: {
        originRef: 'ghi-origin-1',
        ownerId: 'user-1',
        conversationId: 'conversation-1',
        anchorMessageId: 'assistant-anchor',
        mainAgentId: 'main-agent',
        feelingsIsolated: true,
      },
      body: {
        callback_id: 'cb-isolated',
        event: 'run.completed',
        work_terminal: true,
        work_state: 'completed',
        message: 'Verified result.',
        feelingsIsolated: false,
      },
    });
    expect(mockUpdateOne.mock.calls[0][1].$setOnInsert.feelingsIsolated).toBe(true);
  });

  test.each(['run.cancelled', 'run.interrupted'])(
    'retains useful %s terminal evidence for native Main without raw status delivery',
    async (event) => {
      const input = {
        binding: {
          originRef: 'ghi-origin-1',
          workRef: 'gh-work-1',
          ownerId: 'user-1',
          conversationId: 'conversation-1',
          anchorMessageId: 'assistant-anchor',
          mainAgentId: 'main-agent',
          traceIdentity: { callbackRef: canonicalCallbackRef('cb-stop'), attemptNumber: 1 },
          destinations: [{ surface: 'telegram' }],
        },
        body: {
          callback_id: 'cb-stop',
          event,
          work_state: 'cancelled',
          work_terminal: true,
          worker_id: 'worker-1',
          run_id: 'run-1',
          message: 'The saved draft remains available after this stop.',
        },
      };
      await enqueueGlassHiveMissionAdjudication(input);
      expect(mockUpdateOne).toHaveBeenCalledWith(
        expect.any(Object),
        {
          $setOnInsert: expect.objectContaining({
            event,
            evidence: input.body.message,
            state: 'pending',
          }),
        },
        { upsert: true },
      );
      expect(mockCreateCortexFollowUpMessage).not.toHaveBeenCalled();
      expect(mockEnqueueDelivery).not.toHaveBeenCalled();
    },
  );

  test('persists exact terminal evidence idempotently before scheduling synthesis', async () => {
    await enqueueGlassHiveMissionAdjudication({
      binding: {
        originRef: 'ghi-origin-1',
        workRef: 'gh-work-1',
        ownerId: 'user-1',
        conversationId: 'conversation-1',
        anchorMessageId: 'assistant-anchor',
        mainAgentId: 'main-agent',
        traceIdentity: {
          callbackRef: canonicalCallbackRef('cb-1'),
          attemptNumber: 1,
        },
        destinations: [{ surface: 'telegram' }],
      },
      body: {
        callback_id: 'cb-1',
        event: 'run.completed',
        work_state: 'completed',
        work_terminal: true,
        worker_id: 'worker-1',
        run_id: 'run-1',
        message: 'Verified synthetic result.',
      },
    });

    expect(mockUpdateOne).toHaveBeenCalledWith(
      {
        $or: [
          { _id: expect.stringMatching(/^ghe_[a-f0-9]{32}$/) },
          { _id: 'cb-1', ownerId: 'user-1', originRef: 'ghi-origin-1' },
        ],
      },
      {
        $setOnInsert: expect.objectContaining({
          _id: expect.stringMatching(/^ghe_[a-f0-9]{32}$/),
          originRef: 'ghi-origin-1',
          evidence: 'Verified synthetic result.',
          callbackRef: canonicalCallbackRef('cb-1'),
          attemptNumber: 1,
          state: 'pending',
        }),
      },
      { upsert: true },
    );
    expect(mockCreateCortexFollowUpMessage).not.toHaveBeenCalled();
  });

  test('retains exact accepted run input before acknowledgement and rejects cross-run context', async () => {
    const runInput = {
      version: 1,
      run_id: 'run-1',
      instruction: 'Return the requested evidence.',
      continuation_context: {
        version: 1,
        base_instruction: 'Review without submitting.',
        guidance: ['Use the revised figures.'],
      },
    };
    const input = {
      binding: {
        ownerId: 'user-1',
        originRef: 'origin-1',
        conversationId: 'conversation-1',
        anchorMessageId: 'anchor-1',
      },
      body: {
        callback_id: 'cb-1',
        run_id: 'run-1',
        worker_id: 'worker-1',
        event: 'run.completed',
        work_state: 'completed',
        work_terminal: true,
        message: 'Result.',
        run_input: runInput,
      },
    };
    await enqueueGlassHiveMissionAdjudication(input);
    expect(mockUpdateOne.mock.calls[0][1].$setOnInsert).toEqual(
      expect.objectContaining({ ownerId: 'user-1', runId: 'run-1', runInput }),
    );
    const count = mockUpdateOne.mock.calls.length;
    await expect(
      enqueueGlassHiveMissionAdjudication({
        ...input,
        body: { ...input.body, run_id: 'different-run' },
      }),
    ).rejects.toThrow('mission_input_identity_invalid');
    expect(mockUpdateOne.mock.calls).toHaveLength(count);
  });

  test('binds accepted terminal files to the actual Main follow-up and retains its carrier', async () => {
    const callbackId = `cb_terminal_${'c'.repeat(64)}`;
    const resultDigest = `sha256:${'d'.repeat(64)}`;
    const outputFiles = {
      version: 1,
      owner_id: 'user-1',
      run_id: 'run-1',
      attempt_id: 'attempt-1',
      callback_id: callbackId,
      origin_ref: 'ghi-origin-1',
      work_ref: 'gh-work-1',
      result_revision: 1,
      result_digest: resultDigest,
      files: [
        {
          filename: 'result.png',
          mime_type: 'image/png',
          bytes: 3,
          sha256: 'a'.repeat(64),
          download_url: 'https://native.example.test/v1/link-refs/ghr_1234567890abcdef',
        },
      ],
    };
    const callbackInput = {
      binding: { ...row(), runId: 'run-1', attemptId: 'attempt-1' },
      body: {
        callback_id: callbackId,
        run_id: 'run-1',
        attempt_id: 'attempt-1',
        event: 'run.completed',
        work_state: 'completed',
        work_terminal: true,
        message: 'The result is ready.',
        output_files: outputFiles,
      },
      effectFence: {
        resultKey: `ghtr_${'a'.repeat(64)}`,
        acceptedOperationId: 'b'.repeat(32),
        callbackId,
        resultDigest,
        resultRevision: 1,
        generation: 1,
      },
    };
    for (const field of [
      'owner_id',
      'run_id',
      'attempt_id',
      'callback_id',
      'origin_ref',
      'work_ref',
    ]) {
      await expect(
        enqueueGlassHiveMissionAdjudication({
          ...callbackInput,
          body: { ...callbackInput.body, output_files: { ...outputFiles, [field]: 'foreign' } },
        }),
      ).rejects.toThrow('native_output_files_identity_invalid');
    }
    await expect(
      enqueueGlassHiveMissionAdjudication({
        ...callbackInput,
        body: {
          ...callbackInput.body,
          output_files: {
            ...outputFiles,
            files: [{ ...outputFiles.files[0], sha256: 'invalid' }],
          },
        },
      }),
    ).rejects.toThrow('native_output_files_invalid');
    expect(mockUpdateOne).not.toHaveBeenCalled();
    expect(mockPrepareCortexFollowUpMessage).not.toHaveBeenCalled();
    await enqueueGlassHiveMissionAdjudication(callbackInput);
    const stored = mockUpdateOne.mock.calls[0][1].$setOnInsert;
    expect(stored).toMatchObject({ attemptId: 'attempt-1', outputFiles });
    mockFind.mockReturnValueOnce(cursor([stored]));
    mockFindOneAndUpdate.mockResolvedValueOnce({ ...stored, state: 'processing' });
    const attachments = [
      { filename: 'result.png', file_id: 'file-1', filepath: '/uploads/result.png' },
    ];
    mockPrepareMissionOutputFiles.mockResolvedValueOnce(attachments);
    mockPersistPreparedCortexFollowUpMessage.mockImplementationOnce(async (input) => {
      const message = {
        conversationId: input.conversationId,
        messageId: 'actual-main-message',
        agent_id: input.agent.id,
        text: 'Here is the result.',
      };
      message.attachments = await input.dependencies.prepareAttachments(message);
      return storeAuthoredMessage(input, message);
    });
    const result = await flushGlassHiveMissionAdjudications({ ownerId: 'user-1' });
    expect({
      ...result,
      errors: mockRecordOutcome.mock.calls
        .filter(([value]) => value.errorCode)
        .map(([value]) => value.errorCode),
    }).toMatchObject({ visible: 1, failed: 0, errors: [] });
    const insight =
      mockPrepareCortexFollowUpMessage.mock.calls[0][0].insightsData.insights[0].insight;
    const published = JSON.parse(insight.slice(0, insight.indexOf('\n\n'))).output_files;
    // The Queen can use the already published exact file, without rediscovery by filename.
    expect(published).toEqual({ ...outputFiles, count: 1, rejected: [] });
    expect(published.files[0]).toMatchObject({
      sha256: 'a'.repeat(64),
      download_url: 'https://native.example.test/v1/link-refs/ghr_1234567890abcdef',
    });
    expect(mockPrepareMissionOutputFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        rows: [expect.objectContaining({ outputFiles })],
        message: expect.objectContaining({
          messageId: 'actual-main-message',
          agent_id: 'main-agent',
        }),
      }),
    );
    expect(mockEnqueueDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ event: 'main.followup' }),
        message: expect.objectContaining({ messageId: 'actual-main-message', attachments }),
      }),
    );
  });

  test('passes each accepted run input with its exact synthesis authority', async () => {
    const runInput = { version: 1, run_id: 'run-1', instruction: 'Compare the revised document.' };
    mockFind.mockReturnValueOnce(cursor([row({ runInput })]));
    mockFindOneAndUpdate.mockResolvedValueOnce({ ...row({ runInput }), state: 'processing' });
    await flushGlassHiveMissionAdjudications({ ownerId: 'user-1' });
    expect(mockPrepareCortexFollowUpMessage.mock.calls[0][0].insightsData.insights[0]).toEqual(
      expect.objectContaining({
        runInput,
        authority: expect.objectContaining({ kind: 'durable_terminal_callback', runId: 'run-1' }),
      }),
    );
  });

  test('retains native media in the exact owner/run evidence row before synthesis', async () => {
    const nativeMedia = {
      observations: [
        {
          kind: 'image',
          source: 'native_tool_result',
          artifact_ref: `artifact_sha256:${'a'.repeat(64)}`,
          run_id: 'run-1',
          tool_call_id: 'call-1',
          content_index: 0,
          mime_type: 'image/png',
          bytes: 100,
          sha256: 'a'.repeat(64),
          download_url: 'https://artifacts.example.test/v1/link-refs/ghr_1234567890abcdef',
          open_url: 'https://artifacts.example.test/v1/link-refs/ghr_fedcba0987654321',
        },
      ],
      omitted_count: 1,
    };
    const input = {
      binding: {
        ownerId: 'user-1',
        attemptId: 'verified-native-attempt',
        originRef: 'origin-1',
        conversationId: 'conversation-1',
        anchorMessageId: 'anchor-1',
      },
      body: {
        callback_id: 'cb-1',
        run_id: 'run-1',
        worker_id: 'worker-1',
        event: 'run.completed',
        work_state: 'completed',
        work_terminal: true,
        message: 'Observed result.',
        native_media: nativeMedia,
      },
    };
    await enqueueGlassHiveMissionAdjudication(input);
    expect(mockUpdateOne.mock.calls[0][1].$setOnInsert).toEqual(
      expect.objectContaining({
        ownerId: 'user-1',
        runId: 'run-1',
        attemptId: 'verified-native-attempt',
        nativeMedia,
      }),
    );
    expect(mockPrepareCortexFollowUpMessage).not.toHaveBeenCalled();
    const writes = mockUpdateOne.mock.calls.length;
    await expect(
      enqueueGlassHiveMissionAdjudication({
        ...input,
        body: { ...input.body, run_id: 'different-run' },
      }),
    ).rejects.toThrow('native_media_identity_invalid');
    expect(mockUpdateOne.mock.calls).toHaveLength(writes);
  });

  test('defers account adjudication until callback commit and schedules nothing after abort', async () => {
    jest.useFakeTimers();
    const scheduleTimer = jest.spyOn(global, 'setTimeout');
    const afterCommit = [];
    mockDeferAfterCommit.mockImplementation((operation) => {
      afterCommit.push(operation);
      return true;
    });

    const enqueue = (ownerId) =>
      enqueueGlassHiveMissionAdjudication({
        binding: {
          originRef: `ghi-origin-${ownerId}`,
          workRef: `gh-work-${ownerId}`,
          ownerId,
          conversationId: 'conversation-1',
          anchorMessageId: 'assistant-anchor',
          mainAgentId: 'main-agent',
        },
        body: {
          callback_id: `cb-${ownerId}`,
          event: 'run.completed',
          work_state: 'completed',
          work_terminal: true,
          worker_id: 'worker-1',
          run_id: `run-${ownerId}`,
          message: 'Verified synthetic result.',
        },
      });

    await enqueue('committed-owner');

    expect(mockUpdateOne).toHaveBeenCalledTimes(1);
    expect(afterCommit).toHaveLength(1);
    expect(scheduleTimer).not.toHaveBeenCalled();

    await afterCommit[0]();
    await jest.advanceTimersByTimeAsync(COALESCE_MS);

    expect(mockFind).toHaveBeenCalledTimes(1);

    await enqueue('aborted-owner');
    expect(mockUpdateOne).toHaveBeenCalledTimes(2);
    expect(afterCommit).toHaveLength(2);
    expect(scheduleTimer).toHaveBeenCalledTimes(1);
    expect(scheduleTimer).toHaveBeenCalledWith(expect.any(Function), COALESCE_MS);

    await jest.runOnlyPendingTimersAsync();
    expect(mockFind).toHaveBeenCalledTimes(1);
    scheduleTimer.mockRestore();
  });

  describe('conversation delivery scheduling', () => {
    function schedulingRows(rows) {
      mockFind.mockImplementation((filter) => {
        if (filter.state !== 'pending') return cursor([]);
        return cursor(
          rows.filter(
            (item) =>
              item.state === 'pending' &&
              item.ownerId === filter.ownerId &&
              (!filter.adjudicationGroupId ||
                (typeof item.adjudicationGroupId === 'string' &&
                  item.adjudicationGroupId !== '')) &&
              (filter.conversationId === undefined ||
                (typeof filter.conversationId === 'object'
                  ? filter.conversationId.$in.includes(item.conversationId ?? null)
                  : item.conversationId === filter.conversationId)),
          ),
        );
      });
      mockFindOneAndUpdate.mockImplementation(async (filter) => {
        const item = rows.find((entry) => entry._id === filter._id && entry.state === filter.state);
        if (!item) return null;
        item.state = 'processing';
        return { ...item };
      });
      mockUpdateOne.mockImplementation(async (filter, update) => {
        const item = rows.find((entry) => entry._id === filter._id);
        if (item && update.$set) Object.assign(item, update.$set);
        return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
      });
      mockCreateCortexFollowUpMessage.mockImplementation(async (input) => ({
        messageId: `follow-up-${input.conversationId}`,
        text: 'Main-authored synthetic result.',
      }));
    }

    function enqueueScheduled(item) {
      return enqueueGlassHiveMissionAdjudication({
        binding: {
          originRef: item.originRef,
          workRef: item.workRef,
          ownerId: item.ownerId,
          conversationId: item.conversationId,
          anchorMessageId: item.anchorMessageId,
          mainAgentId: item.mainAgentId,
          destinations: item.destinations,
        },
        body: {
          callback_id: item._id,
          event: item.event,
          work_state: item.workState,
          work_terminal: true,
          worker_id: item.workerId,
          run_id: item.runId,
          message: item.evidence,
        },
      });
    }

    test('Main-ready wake immediately claims an already-pinned group without another coalescing wait', async () => {
      jest.useFakeTimers();
      const pending = row({
        adjudicationGroupId: `ghag_${'a'.repeat(32)}`,
        adjudicationGroupMemberIds: ['cb-1'],
        adjudicationGroupPinnedAt: new Date(),
      });
      schedulingRows([pending]);
      require('../GlassHiveMissionAdjudicationService').wakeGlassHiveMissionAdjudications({
        ownerId: pending.ownerId,
        conversationId: pending.conversationId,
      });
      await jest.advanceTimersByTimeAsync(0);
      expect(mockPrepareCortexFollowUpMessage).toHaveBeenCalledTimes(1);
      expect(mockEnqueueDelivery).toHaveBeenCalledTimes(1);
      expect(pending.state).toBe('completed');
      expect(pending.adjudicationGroupMemberIds).toEqual(['cb-1']);
      expect(jest.getTimerCount()).toBe(0);
    });

    test('ready wake preserves new arrivals and their initial coalescing timer', async () => {
      jest.useFakeTimers();
      const pinned = row({
        adjudicationGroupId: `ghag_${'a'.repeat(32)}`,
        adjudicationGroupMemberIds: ['cb-1'],
        adjudicationGroupPinnedAt: new Date(),
      });
      const fresh = row({
        _id: 'cb-2',
        evidenceId: 'cb-2',
        originRef: 'ghi-origin-2',
        workRef: 'gh-work-2',
        runId: 'run-2',
      });
      const otherOwner = row({
        _id: 'cb-foreign',
        ownerId: 'other-owner',
        adjudicationGroupId: `ghag_${'f'.repeat(32)}`,
        adjudicationGroupMemberIds: ['cb-foreign'],
        adjudicationGroupPinnedAt: new Date(),
      });
      schedulingRows([pinned, fresh, otherOwner]);
      await enqueueScheduled(fresh);
      require('../GlassHiveMissionAdjudicationService').wakeGlassHiveMissionAdjudications({
        ownerId: pinned.ownerId,
        conversationId: pinned.conversationId,
      });
      await jest.advanceTimersByTimeAsync(0);
      expect(mockPrepareCortexFollowUpMessage).toHaveBeenCalledTimes(1);
      expect(pinned.state).toBe('completed');
      expect(fresh.state).toBe('pending');
      expect(fresh.adjudicationGroupId).toBeUndefined();
      expect(otherOwner.state).toBe('pending');
      expect(jest.getTimerCount()).toBe(1);
      await jest.advanceTimersByTimeAsync(COALESCE_MS - 1);
      expect(mockPrepareCortexFollowUpMessage).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(mockPrepareCortexFollowUpMessage).toHaveBeenCalledTimes(2);
      expect(fresh.state).toBe('completed');
      expect(fresh.adjudicationGroupMemberIds).toEqual(['cb-2']);
      expect(pinned.adjudicationGroupMemberIds).toEqual(['cb-1']);
      expect(otherOwner.state).toBe('pending');
    });

    test('matured collection waits for the shared lane and is not narrowed by a ready wake', async () => {
      jest.useFakeTimers();
      const service = require('../GlassHiveMissionAdjudicationService');
      const pinned = row({
        adjudicationGroupId: `ghag_${'a'.repeat(32)}`,
        adjudicationGroupMemberIds: ['cb-1'],
        adjudicationGroupPinnedAt: new Date(),
      });
      const fresh = row({
        _id: 'cb-2',
        evidenceId: 'cb-2',
        originRef: 'ghi-origin-2',
        workRef: 'gh-work-2',
        runId: 'run-2',
      });
      schedulingRows([pinned, fresh]);
      let release;
      const blocked = new Promise((resolve) => {
        release = resolve;
      });
      mockPrepareCortexFollowUpMessage.mockReturnValueOnce(blocked);
      service.wakeGlassHiveMissionAdjudications({
        ownerId: pinned.ownerId,
        conversationId: pinned.conversationId,
      });
      await jest.advanceTimersByTimeAsync(0);
      expect(mockPrepareCortexFollowUpMessage).toHaveBeenCalledTimes(1);
      await enqueueScheduled(fresh);
      await jest.advanceTimersByTimeAsync(COALESCE_MS);
      service.wakeGlassHiveMissionAdjudications({
        ownerId: pinned.ownerId,
        conversationId: pinned.conversationId,
      });
      await jest.advanceTimersByTimeAsync(0);
      expect(mockPrepareCortexFollowUpMessage).toHaveBeenCalledTimes(1);
      expect(fresh.adjudicationGroupId).toBeUndefined();
      release({ prepared: true });
      await jest.advanceTimersByTimeAsync(0);
      expect(mockPrepareCortexFollowUpMessage).toHaveBeenCalledTimes(2);
      expect(fresh.state).toBe('completed');
      expect(pinned.adjudicationGroupMemberIds).toEqual(['cb-1']);
      expect(fresh.adjudicationGroupMemberIds).toEqual(['cb-2']);
      expect(jest.getTimerCount()).toBe(0);
    });

    test('delivers another conversation while the first conversation synthesis is blocked', async () => {
      jest.useFakeTimers();
      const first = row({ _id: 'cb-a', evidenceId: 'cb-a', conversationId: 'conversation-a' });
      const second = row({
        _id: 'cb-b',
        evidenceId: 'cb-b',
        conversationId: 'conversation-b',
        originRef: 'ghi-origin-b',
        workRef: 'gh-work-b',
        runId: 'run-b',
      });
      schedulingRows([first, second]);
      let release;
      const blocked = new Promise((resolve) => {
        release = resolve;
      });
      mockPrepareCortexFollowUpMessage.mockImplementation((input) =>
        input.conversationId === first.conversationId
          ? blocked
          : Promise.resolve({ prepared: true }),
      );
      await enqueueScheduled(first);
      await jest.advanceTimersByTimeAsync(COALESCE_MS);
      expect(mockPrepareCortexFollowUpMessage).toHaveBeenCalledTimes(1);
      await enqueueScheduled(second);
      await jest.advanceTimersByTimeAsync(COALESCE_MS);
      expect(mockEnqueueDelivery).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.objectContaining({ messageId: 'follow-up-conversation-b' }),
        }),
      );
      expect(first.state).toBe('processing');
      expect(second.state).toBe('completed');
      release({ prepared: true });
      await jest.advanceTimersByTimeAsync(0);
      expect(mockEnqueueDelivery).toHaveBeenCalledTimes(2);
    });

    test('reconciliation schedules another conversation while an existing lane is busy', async () => {
      jest.useFakeTimers();
      const first = row({ _id: 'cb-a', evidenceId: 'cb-a', conversationId: 'conversation-a' });
      const second = row({
        _id: 'cb-b',
        evidenceId: 'cb-b',
        conversationId: 'conversation-b',
        originRef: 'ghi-origin-b',
        workRef: 'gh-work-b',
        runId: 'run-b',
      });
      schedulingRows([first, second]);
      const pendingFind = mockFind.getMockImplementation();
      mockFind.mockImplementation((filter) =>
        filter.$or ? cursor([second]) : pendingFind(filter),
      );
      let release;
      const blocked = new Promise((resolve) => {
        release = resolve;
      });
      mockPrepareCortexFollowUpMessage.mockImplementation((input) =>
        input.conversationId === first.conversationId
          ? blocked
          : Promise.resolve({ prepared: true }),
      );
      await enqueueScheduled(first);
      await jest.advanceTimersByTimeAsync(COALESCE_MS);
      await expect(reconcilePendingGlassHiveMissionAdjudications()).resolves.toEqual({
        rows: 1,
        owners: 1,
      });
      await jest.advanceTimersByTimeAsync(COALESCE_MS);
      expect(mockEnqueueDelivery).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.objectContaining({ messageId: 'follow-up-conversation-b' }),
        }),
      );
      expect(first.state).toBe('processing');
      release({ prepared: true });
      await jest.advanceTimersByTimeAsync(0);
      expect(mockEnqueueDelivery).toHaveBeenCalledTimes(2);
    });

    test.each(['', null, undefined])(
      'recovers retained blank conversation %s in the fallback lane',
      async (conversationId) => {
        jest.useFakeTimers();
        const retained = row({ conversationId });
        schedulingRows([retained]);
        mockFind.mockImplementation((filter) => {
          if (filter.$or) return cursor([retained]);
          if (filter.state !== 'pending') return cursor([]);
          const values = filter.conversationId?.$in;
          return cursor(values?.includes(conversationId ?? null) ? [retained] : []);
        });
        await expect(reconcilePendingGlassHiveMissionAdjudications()).resolves.toEqual({
          rows: 1,
          owners: 1,
        });
        await jest.advanceTimersByTimeAsync(COALESCE_MS);
        expect(mockFind).toHaveBeenLastCalledWith({
          ownerId: retained.ownerId,
          state: 'pending',
          conversationId: { $in: ['', null] },
        });
        expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
          { _id: retained._id, state: 'pending' },
          expect.any(Object),
          expect.any(Object),
        );
        expect(retained.state).toBe('failed');
        expect(retained.errorCode).toBe('mission_adjudication_preflight_failed');
        expect(mockPrepareCortexFollowUpMessage).not.toHaveBeenCalled();
      },
    );

    test('retains an omitted conversation as the direct owner flush contract', async () => {
      schedulingRows([row()]);
      await flushGlassHiveMissionAdjudications({ ownerId: 'user-1' });
      expect(mockFind).toHaveBeenCalledWith({ ownerId: 'user-1', state: 'pending' });
      expect(mockEnqueueDelivery).toHaveBeenCalledTimes(1);
    });
  });

  test('serializes one conversation flush and resumes a matured lossless follow-up immediately', async () => {
    jest.useFakeTimers();
    const firstRow = row({ _id: 'cb-a', evidenceId: 'cb-a', evidence: 'First result.' });
    const secondRow = row({
      _id: 'cb-b',
      evidenceId: 'cb-b',
      originRef: 'ghi-origin-2',
      workRef: 'gh-work-2',
      workerId: 'worker-2',
      runId: 'run-2',
      callbackRef: canonicalCallbackRef('cb-b'),
      evidence: 'Second result.',
    });
    mockFind.mockReturnValueOnce(cursor([firstRow])).mockReturnValueOnce(cursor([secondRow]));
    mockFindOneAndUpdate.mockImplementation(async (filter) => ({
      ...(filter._id === 'cb-a' ? firstRow : secondRow),
      state: 'processing',
    }));
    let releaseFirst;
    const firstSynthesis = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    mockCreateCortexFollowUpMessage
      .mockImplementationOnce(() => firstSynthesis)
      .mockResolvedValueOnce({ messageId: 'follow-up-b', text: 'Second result.' });

    await enqueueGlassHiveMissionAdjudication({
      binding: {
        originRef: 'ghi-origin-a',
        workRef: 'gh-work-a',
        ownerId: 'user-1',
        conversationId: 'conversation-1',
        anchorMessageId: 'assistant-anchor',
        mainAgentId: 'main-agent',
      },
      body: {
        callback_id: 'cb-a',
        event: 'run.completed',
        work_state: 'completed',
        work_terminal: true,
        worker_id: 'worker-a',
        run_id: 'run-a',
        message: 'First result.',
      },
    });
    await jest.advanceTimersByTimeAsync(COALESCE_MS);
    expect(mockCreateCortexFollowUpMessage).toHaveBeenCalledTimes(1);

    await enqueueGlassHiveMissionAdjudication({
      binding: {
        originRef: 'ghi-origin-b',
        workRef: 'gh-work-b',
        ownerId: 'user-1',
        conversationId: 'conversation-1',
        anchorMessageId: 'assistant-anchor',
        mainAgentId: 'main-agent',
      },
      body: {
        callback_id: 'cb-b',
        event: 'run.completed',
        work_state: 'completed',
        work_terminal: true,
        worker_id: 'worker-b',
        run_id: 'run-b',
        message: 'Second result.',
      },
    });
    await jest.advanceTimersByTimeAsync(COALESCE_MS);
    expect(mockCreateCortexFollowUpMessage).toHaveBeenCalledTimes(1);

    releaseFirst({ messageId: 'follow-up-a', text: 'First result.' });
    await jest.advanceTimersByTimeAsync(0);
    expect(jest.getTimerCount()).toBe(0);
    expect(mockCreateCortexFollowUpMessage).toHaveBeenCalledTimes(2);
    expect(mockFind).toHaveBeenCalledTimes(2);
  });

  test('same vendor callback id cannot collide across trusted owners or origins', async () => {
    const body = {
      callback_id: 'cb-shared-vendor-id',
      event: 'run.completed',
      work_state: 'completed',
      work_terminal: true,
      worker_id: 'worker-shared',
      run_id: 'run-shared',
      message: 'Verified synthetic result.',
    };
    await enqueueGlassHiveMissionAdjudication({
      binding: {
        originRef: 'ghi-owner-a-origin',
        workRef: 'gh-work-a',
        ownerId: 'user-a',
        conversationId: 'conversation-a',
        anchorMessageId: 'assistant-a',
        mainAgentId: 'main-agent',
      },
      body,
    });
    await enqueueGlassHiveMissionAdjudication({
      binding: {
        originRef: 'ghi-owner-b-origin',
        workRef: 'gh-work-b',
        ownerId: 'user-b',
        conversationId: 'conversation-b',
        anchorMessageId: 'assistant-b',
        mainAgentId: 'main-agent',
      },
      body,
    });

    const firstFilter = mockUpdateOne.mock.calls[0][0];
    const secondFilter = mockUpdateOne.mock.calls[1][0];
    expect(firstFilter.$or[0]._id).not.toBe(secondFilter.$or[0]._id);
    expect(firstFilter.$or[1]).toEqual({
      _id: 'cb-shared-vendor-id',
      ownerId: 'user-a',
      originRef: 'ghi-owner-a-origin',
    });
    expect(secondFilter.$or[1]).toEqual({
      _id: 'cb-shared-vendor-id',
      ownerId: 'user-b',
      originRef: 'ghi-owner-b-origin',
    });
  });

  test('does not persist or synthesize evidence for a completed run with queued sibling work', async () => {
    await expect(
      enqueueGlassHiveMissionAdjudication({
        binding: {
          originRef: 'ghi-sibling-origin',
          workRef: 'gh-work-with-sibling',
          ownerId: 'user-1',
          conversationId: 'conversation-1',
          anchorMessageId: 'assistant-anchor',
          mainAgentId: 'main-agent',
        },
        body: {
          callback_id: 'cb-run-checkpoint',
          event: 'run.completed',
          run_state: 'completed',
          work_state: 'queued',
          work_terminal: false,
          worker_id: 'worker-1',
          run_id: 'run-original',
          message: 'Original run finished while its queued continuation remains.',
        },
      }),
    ).resolves.toBeNull();

    expect(mockUpdateOne).not.toHaveBeenCalled();
    expect(mockCreateCortexFollowUpMessage).not.toHaveBeenCalled();
  });

  test('coalesces same-account mission evidence into existing Main Phase-B synthesis', async () => {
    const media = { observations: [], omitted_count: 2 };
    const rows = [
      row({ nativeMedia: media, requestedParentMessageId: 'original-user-a' }),
      row({
        _id: 'cb-2',
        evidenceId: 'cb-2',
        callbackRef: canonicalCallbackRef('cb-2'),
        originRef: 'ghi-origin-2',
        anchorMessageId: 'assistant-anchor-newer',
        requestedParentMessageId: 'original-user-b',
        evidence: 'Second result.',
        runId: 'run-2',
      }),
    ];
    mockFind.mockReturnValueOnce(cursor(rows));
    mockFindOneAndUpdate.mockImplementation(async (filter) => ({
      ...rows.find((item) => item._id === filter._id),
      state: 'processing',
    }));

    await expect(flushGlassHiveMissionAdjudications({ ownerId: 'user-1' })).resolves.toEqual({
      claimed: 2,
      groups: 1,
      visible: 2,
      silent: 0,
      failed: 0,
    });
    expect(mockCreateCortexFollowUpMessage).toHaveBeenCalledTimes(1);
    expect(mockCreateCortexFollowUpMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: expect.objectContaining({ id: 'main-agent' }),
        parentMessageId: 'assistant-anchor-newer',
        runId: expect.stringMatching(/^ghag_[a-f0-9]{32}$/),
        insightsData: expect.objectContaining({
          insights: [
            {
              cortexName: 'Mission evidence',
              insight: 'Verified synthetic result.',
              nativeMedia: media,
              maxPromptChars: 12_000,
              authority: {
                kind: 'durable_terminal_callback',
                userSource: { messageId: 'original-user-a', conversationId: 'conversation-1' },
                runId: 'run-1',
                event: 'run.completed',
                workState: 'completed',
              },
            },
            {
              cortexName: 'Mission evidence',
              insight: 'Second result.',
              maxPromptChars: 12_000,
              authority: {
                kind: 'durable_terminal_callback',
                userSource: { messageId: 'original-user-b', conversationId: 'conversation-1' },
                runId: 'run-2',
                event: 'run.completed',
                workState: 'completed',
              },
            },
          ],
        }),
        forceVisibleFollowUp: true,
        allowMovedOnUsefulFollowUp: true,
      }),
    );
    expect(mockRecordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'completed', followUpMessageId: 'follow-up-1' }),
    );
    expect(mockEnqueueDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          callback_id: canonicalCallbackRef('cb-2'),
          attempt_number: 1,
          event: 'main.followup',
        }),
        message: expect.objectContaining({ messageId: 'follow-up-1' }),
        deliveryContext: expect.objectContaining({
          traceIdentity: {
            callbackRef: canonicalCallbackRef('cb-2'),
            attemptNumber: 1,
          },
          traceCallbackEvent: 'run.completed',
          traceSurface: 'telegram',
          destinations: [
            expect.objectContaining({ surface: 'telegram', telegramChatId: 'chat-1' }),
          ],
        }),
      }),
    );
    expect(mockPrepareCortexFollowUpMessage.mock.calls[0][0].insightsData.insights[0]).toEqual(
      expect.objectContaining({
        nativeMedia: media,
        authority: expect.objectContaining({ kind: 'durable_terminal_callback', runId: 'run-1' }),
      }),
    );
  });

  test('pins bounded media batches without dropping a coalesced mission observation', async () => {
    const media = (runId) => ({
      observations: Array.from({ length: 13 }, (_, content_index) => ({
        kind: 'image',
        source: 'native_tool_result',
        artifact_ref: `artifact_sha256:${'a'.repeat(64)}`,
        run_id: runId,
        tool_call_id: 'call-1',
        content_index,
        mime_type: 'image/png',
        bytes: 100,
        sha256: 'a'.repeat(64),
        download_url: 'https://artifacts.example.test/v1/link-refs/ghr_1234567890abcdef',
        open_url: 'https://artifacts.example.test/v1/link-refs/ghr_fedcba0987654321',
      })),
      omitted_count: 0,
    });
    const rows = [
      row({ nativeMedia: media('run-1') }),
      row({
        _id: 'cb-2',
        evidenceId: 'cb-2',
        originRef: 'ghi-origin-2',
        runId: 'run-2',
        nativeMedia: media('run-2'),
      }),
    ];
    mockFind.mockReturnValueOnce(cursor(rows));
    mockFindOneAndUpdate.mockImplementation(async (filter) => ({
      ...rows.find((item) => item._id === filter._id),
      state: 'processing',
    }));
    const summary = await flushGlassHiveMissionAdjudications({ ownerId: 'user-1' });
    expect(summary).toEqual({ claimed: 2, groups: 2, visible: 2, silent: 0, failed: 0 });
    expect(mockPrepareCortexFollowUpMessage).toHaveBeenCalledTimes(2);
    expect(
      mockPrepareCortexFollowUpMessage.mock.calls.map(
        ([input]) => input.insightsData.insights.flatMap((i) => i.nativeMedia.observations).length,
      ),
    ).toEqual([13, 13]);
    expect(rows[0].adjudicationGroupId).not.toBe(rows[1].adjudicationGroupId);
  });

  test('gives sequential terminal groups under one anchor distinct pinned delivery parents', async () => {
    const first = row({
      _id: 'cb-first',
      evidenceId: 'cb-first',
      createdAt: new Date('2026-08-28T04:54:25.000Z'),
    });
    const second = row({
      _id: 'cb-second',
      evidenceId: 'cb-second',
      originRef: 'ghi-origin-2',
      workRef: 'gh-work-2',
      workerId: 'worker-2',
      runId: 'run-2',
      callbackRef: canonicalCallbackRef('cb-second'),
      evidence: 'Second result.',
      createdAt: new Date('2026-08-28T04:54:28.001Z'),
    });
    mockFind.mockReturnValueOnce(cursor([first])).mockReturnValueOnce(cursor([second]));
    mockFindOneAndUpdate.mockImplementation(async (filter) => ({
      ...(filter._id === 'cb-first' ? first : second),
      state: 'processing',
    }));
    let persistedPredecessorReads = 0;
    mockFindOne.mockImplementation(async (filter) => {
      if (!filter?.followUpMessageId?.$nin) return null;
      persistedPredecessorReads += 1;
      return persistedPredecessorReads === 1 ? null : { followUpMessageId: 'follow-up-first' };
    });
    mockCreateCortexFollowUpMessage
      .mockResolvedValueOnce({ messageId: 'follow-up-first', text: 'First result.' })
      .mockResolvedValueOnce({ messageId: 'follow-up-second', text: 'Second result.' });

    await expect(flushGlassHiveMissionAdjudications({ ownerId: 'user-1' })).resolves.toEqual(
      expect.objectContaining({ visible: 1, failed: 0 }),
    );
    await expect(flushGlassHiveMissionAdjudications({ ownerId: 'user-1' })).resolves.toEqual(
      expect.objectContaining({ visible: 1, failed: 0 }),
    );

    expect(mockCreateCortexFollowUpMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        parentMessageId: 'assistant-anchor',
        deliveryParentMessageId: 'assistant-anchor',
      }),
    );
    expect(mockCreateCortexFollowUpMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        parentMessageId: 'assistant-anchor',
        deliveryParentMessageId: 'follow-up-first',
      }),
    );
    expect(mockUpdateOne).toHaveBeenCalledWith(
      { _id: 'cb-first', state: 'processing' },
      expect.objectContaining({
        $set: expect.objectContaining({
          deliveryLedgerParentMessageId: 'assistant-anchor',
        }),
      }),
    );
    expect(mockUpdateOne).toHaveBeenCalledWith(
      { _id: 'cb-second', state: 'processing' },
      expect.objectContaining({
        $set: expect.objectContaining({
          deliveryLedgerParentMessageId: 'follow-up-first',
        }),
      }),
    );
  });

  test('reuses a pinned delivery parent when a failed group retries', async () => {
    const retryRow = row({
      _id: 'cb-retry',
      evidenceId: 'cb-retry',
      deliveryLedgerParentMessageId: 'follow-up-before-retry',
    });
    mockFind.mockReturnValueOnce(cursor([retryRow])).mockReturnValueOnce(cursor([retryRow]));
    mockFindOneAndUpdate.mockResolvedValue({ ...retryRow, state: 'processing', attempts: 2 });
    mockCreateCortexFollowUpMessage
      .mockRejectedValueOnce(
        Object.assign(new Error('synthetic outage'), { code: 'provider_unavailable' }),
      )
      .mockResolvedValueOnce({ messageId: 'follow-up-after-retry', text: 'Recovered.' });

    await expect(flushGlassHiveMissionAdjudications({ ownerId: 'user-1' })).resolves.toEqual(
      expect.objectContaining({ failed: 1 }),
    );
    await expect(flushGlassHiveMissionAdjudications({ ownerId: 'user-1' })).resolves.toEqual(
      expect.objectContaining({ visible: 1, failed: 0 }),
    );

    expect(mockCreateCortexFollowUpMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ deliveryParentMessageId: 'follow-up-before-retry' }),
    );
    expect(mockCreateCortexFollowUpMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ deliveryParentMessageId: 'follow-up-before-retry' }),
    );
  });

  test('pins immutable adjudication membership before consuming the group attempt', async () => {
    const first = row({ _id: 'cb-member-a', evidenceId: 'cb-member-a' });
    const second = row({
      _id: 'cb-member-b',
      evidenceId: 'cb-member-b',
      originRef: 'ghi-origin-member-b',
      workRef: 'gh-work-member-b',
      callbackRef: canonicalCallbackRef('cb-member-b'),
    });
    mockFind.mockReturnValueOnce(cursor([first, second]));
    mockFindOneAndUpdate.mockImplementation(async (filter) => ({
      ...(filter._id === first._id ? first : second),
      state: 'processing',
    }));

    await expect(flushGlassHiveMissionAdjudications({ ownerId: 'user-1' })).resolves.toEqual(
      expect.objectContaining({ claimed: 2, visible: 2, failed: 0 }),
    );

    const membershipWriteIndexes = mockUpdateOne.mock.calls
      .map(([, update], index) => (update?.$set?.adjudicationGroupId ? index : -1))
      .filter((index) => index >= 0);
    const membershipWrites = membershipWriteIndexes.map((index) => mockUpdateOne.mock.calls[index]);
    expect(membershipWrites).toHaveLength(2);
    const groupIds = new Set(membershipWrites.map(([, update]) => update.$set.adjudicationGroupId));
    expect(groupIds.size).toBe(1);
    for (const [, update] of membershipWrites) {
      expect(update.$set.adjudicationGroupMemberIds).toEqual(['cb-member-a', 'cb-member-b']);
      expect(update.$set.adjudicationGroupPinnedAt).toEqual(expect.any(Date));
    }
    expect(
      Math.max(
        ...membershipWriteIndexes.map((index) => mockUpdateOne.mock.invocationCallOrder[index]),
      ),
    ).toBeLessThan(mockFindOneAndUpdate.mock.invocationCallOrder[0]);
  });

  test('recovers an unpinned member after a partial membership-pin crash', async () => {
    const groupId = `ghag_${'d'.repeat(32)}`;
    const members = ['cb-partial-pin-a', 'cb-partial-pin-b'];
    const first = row({
      _id: members[0],
      evidenceId: members[0],
      createdAt: new Date('2026-08-28T04:54:25.000Z'),
      adjudicationGroupId: groupId,
      adjudicationGroupMemberIds: members,
      adjudicationGroupPinnedAt: new Date('2026-08-28T04:54:25.000Z'),
    });
    const second = row({
      _id: members[1],
      evidenceId: members[1],
      originRef: 'ghi-origin-partial-pin-b',
      workRef: 'gh-work-partial-pin-b',
      callbackRef: canonicalCallbackRef('cb-partial-pin-b'),
      createdAt: new Date('2026-08-28T04:54:25.001Z'),
    });
    mockFind.mockReturnValueOnce(cursor([first, second]));
    mockFindOneAndUpdate.mockImplementation(async (filter) => ({
      ...(filter._id === first._id ? first : second),
      state: 'processing',
      attempts: 1,
    }));
    mockFindOne.mockImplementation(async (filter) => {
      const excludedGroupIds = Array.isArray(filter?.adjudicationGroupId?.$nin)
        ? filter.adjudicationGroupId.$nin
        : [filter?.adjudicationGroupId?.$ne];
      if (Array.isArray(filter?.$or) && !excludedGroupIds.includes(groupId)) return first;
      return null;
    });

    await expect(flushGlassHiveMissionAdjudications({ ownerId: 'user-1' })).resolves.toEqual({
      claimed: 2,
      groups: 1,
      visible: 2,
      silent: 0,
      failed: 0,
    });

    expect(mockUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: second._id, state: 'pending' }),
      expect.objectContaining({
        $set: expect.objectContaining({
          adjudicationGroupId: groupId,
          adjudicationGroupMemberIds: members,
          adjudicationGroupPinnedAt: first.adjudicationGroupPinnedAt,
        }),
      }),
    );
    expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(2);
    expect(mockCreateCortexFollowUpMessage).toHaveBeenCalledTimes(1);
    expect(mockCreateCortexFollowUpMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        insightsData: expect.objectContaining({ cortexCount: 2 }),
      }),
    );
  });

  test('keeps one exact retry group when only one pinned member persisted the follow-up', async () => {
    const activeSession = { id: 'synthetic-partial-follow-up-session' };
    mockTransactionSession = activeSession;
    const groupId = `ghag_${'1'.repeat(32)}`;
    const members = ['cb-partial-follow-up-a', 'cb-partial-follow-up-b'];
    const first = row({
      _id: members[0],
      evidenceId: members[0],
      adjudicationGroupId: groupId,
      adjudicationGroupMemberIds: members,
      adjudicationGroupPinnedAt: new Date('2026-08-28T05:02:25.000Z'),
      followUpMessageId: 'follow-up-before-partial-crash',
      followUpText: 'Persisted before the partial crash.',
      authoredAt: new Date('2026-08-28T05:02:26.000Z'),
    });
    const second = row({
      _id: members[1],
      evidenceId: members[1],
      originRef: 'ghi-origin-partial-follow-up-b',
      workRef: 'gh-work-partial-follow-up-b',
      callbackRef: canonicalCallbackRef('cb-partial-follow-up-b'),
      adjudicationGroupId: groupId,
      adjudicationGroupMemberIds: members,
      adjudicationGroupPinnedAt: new Date('2026-08-28T05:02:25.000Z'),
    });
    retainAuthoredFollowUp(first);
    mockFind.mockReturnValueOnce(cursor([first, second]));
    mockFindOneAndUpdate.mockImplementation(async (filter) => ({
      ...(filter._id === first._id ? first : second),
      state: 'processing',
      attempts: 2,
    }));

    await expect(flushGlassHiveMissionAdjudications({ ownerId: 'user-1' })).resolves.toEqual({
      claimed: 2,
      groups: 1,
      visible: 2,
      silent: 0,
      failed: 0,
    });

    expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(2);
    expect(mockCreateCortexFollowUpMessage).not.toHaveBeenCalled();
    expect(mockUpdateOne).toHaveBeenCalledWith(
      {
        _id: second._id,
        state: 'processing',
        $or: [
          { followUpMessageId: { $exists: false } },
          { followUpMessageId: '' },
          { followUpMessageId: null },
        ],
      },
      expect.objectContaining({
        $set: expect.objectContaining({
          followUpMessageId: first.followUpMessageId,
          followUpText: first.followUpText,
          authoredAt: first.authoredAt,
        }),
      }),
      { session: activeSession },
    );
    expect(mockEnqueueDelivery).toHaveBeenCalledTimes(1);
    expect(mockEnqueueDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        message: {
          messageId: first.followUpMessageId,
          text: first.followUpText,
          user: first.ownerId,
          conversationId: first.accountContinuationConversationId || first.conversationId,
          isCreatedByUser: false,
        },
      }),
    );
    const completedWrites = mockUpdateOne.mock.calls.filter(
      ([, update]) => update?.$set?.state === 'completed',
    );
    expect(completedWrites).toHaveLength(2);
    expect(
      completedWrites.every(
        ([, update]) => update.$set.followUpMessageId === first.followUpMessageId,
      ),
    ).toBe(true);
  });

  test('fails closed when one pinned group contains two persisted follow-up ids', async () => {
    const groupId = `ghag_${'2'.repeat(32)}`;
    const members = ['cb-conflicting-follow-up-a', 'cb-conflicting-follow-up-b'];
    const first = row({
      _id: members[0],
      evidenceId: members[0],
      adjudicationGroupId: groupId,
      adjudicationGroupMemberIds: members,
      adjudicationGroupPinnedAt: new Date('2026-08-28T05:03:25.000Z'),
      followUpMessageId: 'follow-up-conflict-a',
      followUpText: 'First persisted result.',
    });
    const second = row({
      _id: members[1],
      evidenceId: members[1],
      originRef: 'ghi-origin-conflicting-follow-up-b',
      workRef: 'gh-work-conflicting-follow-up-b',
      callbackRef: canonicalCallbackRef('cb-conflicting-follow-up-b'),
      adjudicationGroupId: groupId,
      adjudicationGroupMemberIds: members,
      adjudicationGroupPinnedAt: new Date('2026-08-28T05:03:25.000Z'),
      followUpMessageId: 'follow-up-conflict-b',
      followUpText: 'Second persisted result.',
    });
    mockFind.mockReturnValueOnce(cursor([first, second]));
    mockFindOneAndUpdate.mockImplementation(async (filter) => ({
      ...(filter._id === first._id ? first : second),
      state: 'processing',
      attempts: 2,
    }));

    await expect(flushGlassHiveMissionAdjudications({ ownerId: 'user-1' })).resolves.toEqual({
      claimed: 2,
      groups: 1,
      visible: 0,
      silent: 0,
      failed: 2,
    });

    expect(mockCreateCortexFollowUpMessage).not.toHaveBeenCalled();
    expect(mockEnqueueDelivery).not.toHaveBeenCalled();
    expect(mockPrepareMissionOutputFiles).not.toHaveBeenCalled();
    expect(mockRecordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'failed',
        errorCode: 'mission_adjudication_group_follow_up_conflict',
      }),
    );
    const failedWrites = mockUpdateOne.mock.calls.filter(
      ([, update]) => update?.$set?.state === 'failed',
    );
    expect(failedWrites).toHaveLength(2);
    for (const [, update] of failedWrites) {
      expect(update.$set).not.toHaveProperty('followUpMessageId');
    }
  });

  test('rejects conflicting pinned groups that claim the same pending member', async () => {
    const sharedMemberId = 'cb-conflicting-pin-member';
    const first = row({
      _id: 'cb-conflicting-pin-a',
      evidenceId: 'cb-conflicting-pin-a',
      adjudicationGroupId: `ghag_${'e'.repeat(32)}`,
      adjudicationGroupMemberIds: ['cb-conflicting-pin-a', sharedMemberId],
      adjudicationGroupPinnedAt: new Date('2026-08-28T04:54:25.000Z'),
    });
    const second = row({
      _id: 'cb-conflicting-pin-c',
      evidenceId: 'cb-conflicting-pin-c',
      originRef: 'ghi-origin-conflicting-pin-c',
      workRef: 'gh-work-conflicting-pin-c',
      callbackRef: canonicalCallbackRef('cb-conflicting-pin-c'),
      adjudicationGroupId: `ghag_${'f'.repeat(32)}`,
      adjudicationGroupMemberIds: ['cb-conflicting-pin-c', sharedMemberId],
      adjudicationGroupPinnedAt: new Date('2026-08-28T04:54:25.000Z'),
    });
    const sharedMember = row({
      _id: sharedMemberId,
      evidenceId: sharedMemberId,
      originRef: 'ghi-origin-conflicting-pin-member',
      workRef: 'gh-work-conflicting-pin-member',
      callbackRef: canonicalCallbackRef('cb-conflicting-pin-member'),
    });
    mockFind.mockReturnValueOnce(cursor([first, second, sharedMember]));

    await expect(flushGlassHiveMissionAdjudications({ ownerId: 'user-1' })).rejects.toMatchObject({
      code: 'mission_adjudication_group_membership_conflict',
    });
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mockCreateCortexFollowUpMessage).not.toHaveBeenCalled();
  });

  test('keeps exact retry membership and holds a newer row outside that group', async () => {
    const groupId = `ghag_${'a'.repeat(32)}`;
    const members = ['cb-retry-a', 'cb-retry-b'];
    const first = row({
      _id: members[0],
      evidenceId: members[0],
      attempts: 1,
      adjudicationGroupId: groupId,
      adjudicationGroupMemberIds: members,
      adjudicationGroupPinnedAt: new Date('2026-08-28T04:54:25.000Z'),
    });
    const second = row({
      _id: members[1],
      evidenceId: members[1],
      originRef: 'ghi-origin-retry-b',
      workRef: 'gh-work-retry-b',
      callbackRef: canonicalCallbackRef('cb-retry-b'),
      attempts: 1,
      adjudicationGroupId: groupId,
      adjudicationGroupMemberIds: members,
      adjudicationGroupPinnedAt: new Date('2026-08-28T04:54:25.000Z'),
    });
    const newer = row({
      _id: 'cb-newer-c',
      evidenceId: 'cb-newer-c',
      originRef: 'ghi-origin-newer-c',
      workRef: 'gh-work-newer-c',
      callbackRef: canonicalCallbackRef('cb-newer-c'),
      createdAt: new Date('2026-08-28T04:54:28.001Z'),
    });
    mockFind.mockReturnValueOnce(cursor([first, second, newer]));
    mockFindOneAndUpdate.mockImplementation(async (filter) => ({
      ...[first, second, newer].find((item) => item._id === filter._id),
      state: 'processing',
    }));
    mockFindOne.mockImplementation(async (filter) => {
      const excludedGroupIds = Array.isArray(filter?.adjudicationGroupId?.$nin)
        ? filter.adjudicationGroupId.$nin
        : [filter?.adjudicationGroupId?.$ne];
      if (Array.isArray(filter?.$or) && !excludedGroupIds.includes(groupId)) {
        return { _id: first._id, adjudicationGroupId: groupId, attempts: 1 };
      }
      return null;
    });

    await expect(flushGlassHiveMissionAdjudications({ ownerId: 'user-1' })).resolves.toEqual(
      expect.objectContaining({ claimed: 2, visible: 2, failed: 0 }),
    );

    expect(mockCreateCortexFollowUpMessage).toHaveBeenCalledTimes(1);
    expect(mockCreateCortexFollowUpMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        insightsData: expect.objectContaining({
          insights: expect.arrayContaining([
            expect.objectContaining({ insight: first.evidence }),
            expect.objectContaining({ insight: second.evidence }),
          ]),
          cortexCount: 2,
        }),
      }),
    );
    expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(2);
    expect(mockFindOneAndUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ _id: newer._id }),
      expect.anything(),
      expect.anything(),
    );
  });

  test.each([false, true])(
    'a settled silent predecessor permits the next group (earlier visible result: %s)',
    async (hasVisiblePredecessor) => {
      const newer = row({
        _id: 'cb-after-silence',
        evidenceId: 'cb-after-silence',
        createdAt: new Date('2026-08-28T04:56:13.000Z'),
      });
      const silent = row({
        _id: 'cb-settled-silent',
        state: 'silent',
        attempts: 1,
        followUpMessageId: '',
        adjudicationGroupId: `ghag_${'a'.repeat(32)}`,
        createdAt: new Date('2026-08-28T04:55:13.000Z'),
      });
      const visible = row({
        _id: 'cb-earlier-visible',
        state: 'completed',
        followUpMessageId: 'follow-up-earlier-visible',
        adjudicationGroupId: `ghag_${'b'.repeat(32)}`,
        createdAt: new Date('2026-08-28T04:54:13.000Z'),
      });
      const predecessors = hasVisiblePredecessor ? [silent, visible] : [silent];
      const matches = require('sift').default;
      mockFind.mockReturnValueOnce(cursor([newer]));
      mockFindOne.mockImplementation(async (filter) => predecessors.find(matches(filter)) || null);
      mockFindOneAndUpdate.mockResolvedValueOnce({ ...newer, state: 'processing' });

      await expect(flushGlassHiveMissionAdjudications({ ownerId: 'user-1' })).resolves.toEqual({
        claimed: 1,
        groups: 1,
        visible: 1,
        silent: 0,
        failed: 0,
      });
      expect(mockPrepareCortexFollowUpMessage).toHaveBeenCalledTimes(1);
      expect(mockCreateCortexFollowUpMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          parentMessageId: 'assistant-anchor',
          deliveryParentMessageId: hasVisiblePredecessor
            ? 'follow-up-earlier-visible'
            : 'assistant-anchor',
        }),
      );
      expect(mockUpdateOne).not.toHaveBeenCalledWith(
        expect.objectContaining({ _id: silent._id }),
        expect.anything(),
      );
    },
  );

  test.each([
    ['pending', false, false, false],
    ['processing', false, false, false],
    ['failed', false, false, false],
    ['deadletter', false, false, true],
    ['deadletter', true, false, true],
    ['deadletter', false, true, true],
  ])(
    'terminal predecessor ordering: %s / authored=%s / older=%s',
    async (state, authored, olderVisible, eligible) => {
      const newer = row({
        _id: 'cb-newer-terminal',
        evidenceId: 'cb-newer-terminal',
        createdAt: new Date('2026-08-28T04:56:13.000Z'),
      });
      const predecessor = row({
        _id: 'cb-prior-terminal',
        state,
        attempts: state === 'deadletter' ? 10 : 1,
        errorCode: state === 'deadletter' ? 'mission_adjudication_retry_exhausted' : '',
        followUpMessageId: authored ? 'follow-up-prior-authored' : '',
        adjudicationGroupId: `ghag_${'a'.repeat(32)}`,
        createdAt: new Date('2026-08-28T04:55:13.000Z'),
      });
      const older = row({
        _id: 'cb-older-authored',
        state: 'completed',
        followUpMessageId: 'follow-up-older-authored',
        adjudicationGroupId: `ghag_${'b'.repeat(32)}`,
        createdAt: new Date('2026-08-28T04:54:13.000Z'),
      });
      const retained = olderVisible ? [predecessor, older] : [predecessor];
      const matches = require('sift').default;
      mockFind.mockReturnValueOnce(cursor([newer]));
      mockFindOne.mockImplementation(async (filter) => retained.find(matches(filter)) || null);
      mockFindOneAndUpdate.mockResolvedValueOnce({ ...newer, state: 'processing' });
      const result = await flushGlassHiveMissionAdjudications({ ownerId: 'user-1' });
      expect(result).toEqual({
        claimed: eligible ? 1 : 0,
        groups: eligible ? 1 : 0,
        visible: eligible ? 1 : 0,
        silent: 0,
        failed: 0,
      });
      expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(eligible ? 1 : 0);
      expect(mockPrepareCortexFollowUpMessage).toHaveBeenCalledTimes(eligible ? 1 : 0);
      expect(mockEnqueueDelivery).toHaveBeenCalledTimes(eligible ? 1 : 0);
      if (eligible) {
        expect(mockCreateCortexFollowUpMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            deliveryParentMessageId: authored
              ? 'follow-up-prior-authored'
              : olderVisible
                ? 'follow-up-older-authored'
                : 'assistant-anchor',
          }),
        );
      }
      expect(mockUpdateOne).not.toHaveBeenCalledWith(
        expect.objectContaining({ _id: predecessor._id }),
        expect.anything(),
      );
      expect(predecessor.state).toBe(state);
      expect(predecessor.followUpMessageId).toBe(authored ? 'follow-up-prior-authored' : '');
    },
  );

  test('holds a newer group behind a failed predecessor without consuming an attempt', async () => {
    const newer = row({
      _id: 'cb-held-newer',
      evidenceId: 'cb-held-newer',
      createdAt: new Date('2026-08-28T04:56:13.000Z'),
    });
    mockFind.mockReturnValueOnce(cursor([newer]));
    mockFindOne.mockImplementation(async (filter) =>
      Array.isArray(filter?.$or)
        ? {
            _id: 'cb-failed-prior',
            adjudicationGroupId: `ghag_${'b'.repeat(32)}`,
            attempts: 1,
            state: 'failed',
            followUpMessageId: '',
          }
        : null,
    );

    await expect(flushGlassHiveMissionAdjudications({ ownerId: 'user-1' })).resolves.toEqual({
      claimed: 0,
      groups: 0,
      visible: 0,
      silent: 0,
      failed: 0,
    });

    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mockCreateCortexFollowUpMessage).not.toHaveBeenCalled();
    expect(mockUpdateOne).not.toHaveBeenCalledWith(
      { _id: newer._id, state: 'processing' },
      expect.anything(),
    );
  });

  test('holds a newer group after its predecessor crashes between pin and claim', async () => {
    const firstGroupId = `ghag_${'c'.repeat(32)}`;
    const first = row({
      _id: 'cb-pinned-before-crash',
      evidenceId: 'cb-pinned-before-crash',
      attempts: 0,
      createdAt: new Date('2026-08-28T04:54:25.000Z'),
      adjudicationGroupId: firstGroupId,
      adjudicationGroupMemberIds: ['cb-pinned-before-crash'],
      adjudicationGroupPinnedAt: new Date('2026-08-28T04:54:25.000Z'),
    });
    const newer = row({
      _id: 'cb-after-pin-crash',
      evidenceId: 'cb-after-pin-crash',
      originRef: 'ghi-origin-after-pin-crash',
      workRef: 'gh-work-after-pin-crash',
      callbackRef: canonicalCallbackRef('cb-after-pin-crash'),
      createdAt: new Date('2026-08-28T04:56:13.000Z'),
    });
    mockFind.mockReturnValueOnce(cursor([first, newer])).mockReturnValueOnce(cursor([newer]));
    mockFindOneAndUpdate.mockImplementation(async (filter) => {
      const source = filter._id === first._id ? first : newer;
      return { ...source, state: 'processing', attempts: Number(source.attempts || 0) + 1 };
    });
    let firstFollowUpMessageId = '';
    mockUpdateOne.mockImplementation(async (filter, update) => {
      if (filter?._id === first._id && update?.$set?.followUpMessageId) {
        firstFollowUpMessageId = update.$set.followUpMessageId;
      }
      return { acknowledged: true };
    });
    mockFindOne.mockImplementation(async (filter) => {
      const excludedGroupIds = Array.isArray(filter?.adjudicationGroupId?.$nin)
        ? filter.adjudicationGroupId.$nin
        : [filter?.adjudicationGroupId?.$ne];
      if (excludedGroupIds.includes(firstGroupId)) return null;
      const requestsMissingFollowUp = Array.isArray(filter?.$or);
      if (requestsMissingFollowUp && !firstFollowUpMessageId) {
        if (filter?.attempts?.$gt === 0 && first.attempts === 0) return null;
        return first;
      }
      if (filter?.followUpMessageId?.$nin && firstFollowUpMessageId) {
        return { ...first, followUpMessageId: firstFollowUpMessageId };
      }
      return null;
    });
    mockCreateCortexFollowUpMessage
      .mockResolvedValueOnce({ messageId: 'follow-up-pinned-before-crash', text: 'First result.' })
      .mockResolvedValueOnce({ messageId: 'follow-up-after-pin-crash', text: 'Second result.' });

    await expect(flushGlassHiveMissionAdjudications({ ownerId: 'user-1' })).resolves.toEqual({
      claimed: 1,
      groups: 1,
      visible: 1,
      silent: 0,
      failed: 0,
    });
    expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(mockFindOneAndUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ _id: newer._id }),
      expect.anything(),
      expect.anything(),
    );

    await expect(flushGlassHiveMissionAdjudications({ ownerId: 'user-1' })).resolves.toEqual({
      claimed: 1,
      groups: 1,
      visible: 1,
      silent: 0,
      failed: 0,
    });
    expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(2);
    expect(mockCreateCortexFollowUpMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        parentMessageId: 'assistant-anchor',
        deliveryParentMessageId: 'follow-up-pinned-before-crash',
      }),
    );
  });

  test('chains after a persisted delivery-pending predecessor', async () => {
    const newer = row({
      _id: 'cb-after-delivery-pending',
      evidenceId: 'cb-after-delivery-pending',
      createdAt: new Date('2026-08-28T04:56:13.000Z'),
    });
    mockFind.mockReturnValueOnce(cursor([newer]));
    mockFindOne.mockImplementation(async (filter) => {
      if (filter?.attempts?.$gt === 0) return null;
      if (filter?.followUpMessageId?.$nin) {
        return {
          _id: 'cb-delivery-pending-prior',
          state: 'delivery_pending',
          followUpMessageId: 'follow-up-delivery-pending',
          createdAt: new Date('2026-08-28T04:54:25.000Z'),
        };
      }
      return null;
    });

    await expect(flushGlassHiveMissionAdjudications({ ownerId: 'user-1' })).resolves.toEqual(
      expect.objectContaining({ visible: 1, failed: 0 }),
    );

    expect(mockCreateCortexFollowUpMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        parentMessageId: 'assistant-anchor',
        deliveryParentMessageId: 'follow-up-delivery-pending',
      }),
    );
  });

  test('reuses the prior account continuation for a later deleted-origin group', async () => {
    const first = row({
      _id: 'cb-deleted-first',
      evidenceId: 'cb-deleted-first',
      createdAt: new Date('2026-08-28T04:54:25.000Z'),
    });
    const second = row({
      _id: 'cb-deleted-second',
      evidenceId: 'cb-deleted-second',
      originRef: 'ghi-origin-deleted-second',
      workRef: 'gh-work-deleted-second',
      callbackRef: canonicalCallbackRef('cb-deleted-second'),
      createdAt: new Date('2026-08-28T04:56:13.000Z'),
    });
    mockGetConvo.mockResolvedValue(null);
    mockFind.mockReturnValueOnce(cursor([first])).mockReturnValueOnce(cursor([second]));
    mockFindOneAndUpdate.mockImplementation(async (filter) => ({
      ...(filter._id === first._id ? first : second),
      state: 'processing',
    }));
    let continuationConversationId = '';
    let priorReadCount = 0;
    mockFindOne.mockImplementation(async (filter) => {
      if (filter?.attempts?.$gt === 0) return null;
      if (filter?.followUpMessageId?.$nin) {
        priorReadCount += 1;
        return priorReadCount === 1
          ? null
          : {
              _id: first._id,
              followUpMessageId: 'follow-up-deleted-first',
              accountContinuationConversationId: continuationConversationId,
              accountContinuationAnchorMessageId: '00000000-0000-0000-0000-000000000000',
              createdAt: first.createdAt,
            };
      }
      return null;
    });
    mockCreateCortexFollowUpMessage
      .mockImplementationOnce(async (input) => {
        continuationConversationId = input.conversationId;
        return { messageId: 'follow-up-deleted-first', text: 'First result.' };
      })
      .mockResolvedValueOnce({ messageId: 'follow-up-deleted-second', text: 'Second result.' });

    await flushGlassHiveMissionAdjudications({ ownerId: 'user-1' });
    await flushGlassHiveMissionAdjudications({ ownerId: 'user-1' });

    expect(mockCreateCortexFollowUpMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        conversationId: continuationConversationId,
        parentMessageId: '00000000-0000-0000-0000-000000000000',
        deliveryParentMessageId: 'follow-up-deleted-first',
      }),
    );
    expect(mockUpdateOne).toHaveBeenCalledWith(
      { _id: second._id, state: 'processing' },
      expect.objectContaining({
        $set: expect.objectContaining({
          accountContinuationConversationId: continuationConversationId,
          accountContinuationAnchorMessageId: '00000000-0000-0000-0000-000000000000',
        }),
      }),
    );
  });

  test('replaces a legacy sentinel delivery pin when a deleted-origin group has a predecessor', async () => {
    const noParentMessageId = '00000000-0000-0000-0000-000000000000';
    const continuationConversationId = 'continuation-existing';
    const later = row({
      _id: 'cb-deleted-later-legacy-pin',
      evidenceId: 'cb-deleted-later-legacy-pin',
      createdAt: new Date('2026-08-28T04:56:13.000Z'),
      accountContinuationConversationId: continuationConversationId,
      accountContinuationAnchorMessageId: noParentMessageId,
      deliveryLedgerParentMessageId: noParentMessageId,
    });
    mockGetConvo.mockResolvedValue(null);
    mockFind.mockReturnValueOnce(cursor([later]));
    mockFindOneAndUpdate.mockResolvedValue({ ...later, state: 'processing' });
    mockFindOne.mockImplementation(async (filter) => {
      if (!filter?.followUpMessageId?.$nin) return null;
      return {
        _id: 'cb-deleted-prior-legacy-pin',
        followUpMessageId: 'follow-up-deleted-prior-legacy-pin',
        accountContinuationConversationId: continuationConversationId,
        accountContinuationAnchorMessageId: noParentMessageId,
        createdAt: new Date('2026-08-28T04:54:25.000Z'),
      };
    });

    await expect(flushGlassHiveMissionAdjudications({ ownerId: 'user-1' })).resolves.toEqual(
      expect.objectContaining({ visible: 1, failed: 0 }),
    );

    expect(mockCreateCortexFollowUpMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: continuationConversationId,
        parentMessageId: noParentMessageId,
        deliveryParentMessageId: 'follow-up-deleted-prior-legacy-pin',
      }),
    );
    expect(mockUpdateOne).toHaveBeenCalledWith(
      { _id: later._id, state: 'processing' },
      expect.objectContaining({
        $set: expect.objectContaining({
          deliveryLedgerParentMessageId: 'follow-up-deleted-prior-legacy-pin',
        }),
      }),
    );
  });

  test('rejects a deleted-origin continuation pair that conflicts with its predecessor', async () => {
    const conflicting = row({
      _id: 'cb-deleted-conflict',
      evidenceId: 'cb-deleted-conflict',
      createdAt: new Date('2026-08-28T04:56:13.000Z'),
      accountContinuationConversationId: 'continuation-current',
      accountContinuationAnchorMessageId: '00000000-0000-0000-0000-000000000000',
    });
    mockGetConvo.mockResolvedValue(null);
    mockFind.mockReturnValueOnce(cursor([conflicting]));
    mockFindOneAndUpdate.mockResolvedValue({ ...conflicting, state: 'processing' });
    mockFindOne.mockImplementation(async (filter) => {
      if (filter?.attempts?.$gt === 0) return null;
      if (filter?.followUpMessageId?.$nin) {
        return {
          _id: 'cb-deleted-prior',
          followUpMessageId: 'follow-up-deleted-prior',
          accountContinuationConversationId: 'continuation-prior',
          accountContinuationAnchorMessageId: '00000000-0000-0000-0000-000000000000',
          createdAt: new Date('2026-08-28T04:54:25.000Z'),
        };
      }
      return null;
    });

    await expect(flushGlassHiveMissionAdjudications({ ownerId: 'user-1' })).resolves.toEqual(
      expect.objectContaining({ visible: 0, failed: 1 }),
    );
    expect(mockCreateCortexFollowUpMessage).not.toHaveBeenCalled();
    expect(mockRecordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 'mission_account_continuation_conflict' }),
    );
  });

  test('passes the active Mongo session through scoped findOne reads', async () => {
    const activeSession = { id: 'synthetic-active-session' };
    mockTransactionSession = activeSession;
    mockFind.mockReturnValueOnce(cursor([row({ _id: 'cb-session', evidenceId: 'cb-session' })]));
    mockFindOne.mockResolvedValue(null);

    await flushGlassHiveMissionAdjudications({ ownerId: 'user-1' });

    expect(mockFindOne).toHaveBeenCalled();
    for (const [, options] of mockFindOne.mock.calls) {
      expect(options).toEqual(expect.objectContaining({ session: activeSession }));
    }
  });

  test('hides only the exact neutral completed callback after Main presentation is saved', async () => {
    const fenced = row({
      terminalCallbackResultKey: `ghtr_${'a'.repeat(64)}`,
      terminalCallbackAcceptedOperationId: 'b'.repeat(32),
      terminalCallbackId: `cb_terminal_${'c'.repeat(64)}`,
      terminalCallbackResultDigest: `sha256:${'d'.repeat(64)}`,
      terminalCallbackResultRevision: 1,
      terminalCallbackEffectGeneration: 1,
    });
    mockFind.mockReturnValueOnce(cursor([fenced]));
    mockFindOneAndUpdate.mockResolvedValueOnce({ ...fenced, state: 'processing' });
    const activeSession = { id: 'accepted-result-session' };
    mockRunTransaction = async (operation) => {
      mockTransactionSession = activeSession;
      try {
        return await operation(activeSession);
      } finally {
        mockTransactionSession = null;
      }
    };
    mockMessageUpdateOne.mockImplementationOnce(async (filter, update, options) => {
      expect(mockPersistPreparedCortexFollowUpMessage).toHaveBeenCalledTimes(1);
      expect(filter).toEqual({
        user: 'user-1',
        conversationId: 'conversation-1',
        isCreatedByUser: false,
        'metadata.viventium.type': 'glasshive_worker_callback',
        'metadata.viventium.originRef': 'ghi-origin-1',
        'metadata.viventium.runId': 'run-1',
        'metadata.viventium.callbackId': fenced.terminalCallbackId,
        'metadata.viventium.status.kind': 'mission_status',
        'metadata.viventium.status.state': 'completed',
        'metadata.viventium.hasFullText': false,
      });
      expect(update).toEqual({ $set: { 'metadata.viventium.visibility': 'internal' } });
      expect(options).toEqual({ session: activeSession });
      return { acknowledged: true, matchedCount: 1 };
    });
    await expect(flushGlassHiveMissionAdjudications({ ownerId: 'user-1' })).resolves.toMatchObject({
      visible: 1,
      failed: 0,
    });
    expect(mockMessageUpdateOne).toHaveBeenCalledTimes(1);
  });

  test('keeps neutral status visible when Main presentation cannot be saved', async () => {
    const fenced = row({
      terminalCallbackResultKey: `ghtr_${'a'.repeat(64)}`,
      terminalCallbackAcceptedOperationId: 'b'.repeat(32),
      terminalCallbackId: `cb_terminal_${'c'.repeat(64)}`,
      terminalCallbackResultDigest: `sha256:${'d'.repeat(64)}`,
      terminalCallbackResultRevision: 1,
      terminalCallbackEffectGeneration: 1,
    });
    mockFind.mockReturnValueOnce(cursor([fenced]));
    mockFindOneAndUpdate.mockResolvedValueOnce({ ...fenced, state: 'processing' });
    mockPersistPreparedCortexFollowUpMessage.mockRejectedValueOnce(
      new Error('message_store_unavailable'),
    );
    await expect(flushGlassHiveMissionAdjudications({ ownerId: 'user-1' })).resolves.toMatchObject({
      visible: 0,
      failed: 1,
    });
    expect(mockMessageUpdateOne).not.toHaveBeenCalled();
  });

  test('prepares Main synthesis outside Mongo and persists it inside a fresh terminal fence', async () => {
    const fenced = row({
      terminalCallbackResultKey: `ghtr_${'a'.repeat(64)}`,
      terminalCallbackAcceptedOperationId: 'b'.repeat(32),
      terminalCallbackId: `cb_terminal_${'c'.repeat(64)}`,
      terminalCallbackResultDigest: `sha256:${'d'.repeat(64)}`,
      terminalCallbackResultRevision: 1,
      terminalCallbackEffectGeneration: 1,
    });
    let activeTransaction = 0;
    let transactionSerial = 0;
    mockFind.mockReturnValueOnce(cursor([fenced]));
    mockFindOneAndUpdate.mockResolvedValueOnce({ ...fenced, state: 'processing' });
    mockRunTransaction = jest.fn(async (operation) => {
      const transaction = ++transactionSerial;
      activeTransaction = transaction;
      try {
        return await operation({ id: `session-${transaction}` });
      } finally {
        activeTransaction = 0;
      }
    });
    mockPrepareCortexFollowUpMessage.mockImplementationOnce(async () => {
      expect(transactionSerial).toBe(2);
      expect(activeTransaction).toBe(0);
      return { prepared: true };
    });
    mockPersistPreparedCortexFollowUpMessage.mockImplementationOnce(async (input, prepared) => {
      expect(activeTransaction).toBe(3);
      expect(prepared).toEqual({ prepared: true });
      return storeAuthoredMessage(input, {
        messageId: 'follow-up-fenced',
        text: 'Main-authored result.',
      });
    });
    mockEnqueueDelivery.mockImplementationOnce(async () => {
      expect(activeTransaction).toBe(4);
      return { configured: 1, enqueued: 1 };
    });

    await expect(flushGlassHiveMissionAdjudications({ ownerId: 'user-1' })).resolves.toEqual(
      expect.objectContaining({ visible: 1, failed: 0 }),
    );

    expect(mockRunTransaction).toHaveBeenCalledTimes(4);
    expect(mockPrepareCortexFollowUpMessage).toHaveBeenCalledTimes(1);
    expect(mockPersistPreparedCortexFollowUpMessage).toHaveBeenCalledTimes(1);
    expect(mockEnqueueDelivery).toHaveBeenCalledTimes(1);
  });

  test.each(['voice', 'telegram'])(
    'binds one coalesced %s presentation to every exact Worker',
    async (surface) => {
      const terminalRow = (suffix) => {
        const rawCallbackId = `cb_terminal_${suffix.repeat(64)}`;
        return row({
          _id: `cb-${suffix}`,
          evidenceId: `cb-${suffix}`,
          originRef: `origin-${suffix}`,
          workRef: `work-${suffix}`,
          workerId: `worker-${suffix}`,
          runId: `run-${suffix}`,
          callbackRef: canonicalCallbackRef(rawCallbackId),
          attemptNumber: 1,
          surface,
          destinations: [{ surface, voiceCallSessionId: 'ended-origin-call' }],
          terminalCallbackResultKey: `ghtr_${suffix.repeat(64)}`,
          terminalCallbackAcceptedOperationId: suffix.repeat(32),
          terminalCallbackId: rawCallbackId,
          terminalCallbackResultDigest: `sha256:${suffix.repeat(64)}`,
          terminalCallbackResultRevision: 1,
          terminalCallbackEffectGeneration: 1,
        });
      };
      const rows = [terminalRow('b'), terminalRow('a')];
      mockFind.mockReturnValueOnce(cursor(rows));
      mockFindOneAndUpdate.mockImplementation(async (filter) => ({
        ...rows.find((item) => item._id === filter._id),
        state: 'processing',
      }));
      mockGetActiveCallSessionForConversation.mockResolvedValue({
        callSessionId: 'reconnected-call',
        userId: 'user-1',
        conversationId: 'conversation-1',
        status: 'listening',
      });
      mockCreateCortexFollowUpMessage.mockResolvedValueOnce({
        messageId: 'follow-up-voice-coalesced',
        text: 'Both Workers completed.',
      });

      await expect(flushGlassHiveMissionAdjudications({ ownerId: 'user-1' })).resolves.toEqual(
        expect.objectContaining({ visible: 2, failed: 0 }),
      );

      expect(mockEnqueueDelivery).toHaveBeenCalledTimes(1);
      const input = mockEnqueueDelivery.mock.calls[0][0];
      expect(input.deliveryContext.workerCompletionBindings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ workRef: 'work-a', workerId: 'worker-a' }),
          expect.objectContaining({ workRef: 'work-b', workerId: 'worker-b' }),
        ]),
      );
      if (surface === 'voice') {
        expect(mockGetActiveCallSessionForConversation).toHaveBeenCalledWith({
          userId: 'user-1',
          conversationId: 'conversation-1',
        });
        expect(input.deliveryContext.destinations).toEqual([
          expect.objectContaining({ surface: 'voice', voiceCallSessionId: 'reconnected-call' }),
        ]);
        expect(input.deliveryContext.workerCompletionPresentation).toMatchObject({
          version: 1,
          callSessionId: 'reconnected-call',
          responseMessageId: 'follow-up-voice-coalesced',
          responseDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          bindings: [
            expect.objectContaining({ workRef: 'work-a', workerId: 'worker-a' }),
            expect.objectContaining({ workRef: 'work-b', workerId: 'worker-b' }),
          ],
        });
      } else {
        expect(input.deliveryContext.workerCompletionPresentation).toBeUndefined();
        expect(mockGetActiveCallSessionForConversation).not.toHaveBeenCalled();
      }
      expect(input.body.work_ref).toBe('work-a');
    },
  );

  describe('Worker completion Voice brain propagation', () => {
    const savedAgent = {
      id: 'main-agent',
      provider: 'glasshive',
      model: 'synthetic-main-model',
      model_parameters: { model: 'synthetic-main-model', reasoning_effort: 'high' },
      voice_llm_provider: 'glasshive',
      voice_llm_model: 'synthetic-voice-model',
      voice_llm_model_parameters: { reasoning_effort: 'high' },
      voice_fallback_llm_provider: 'glasshive',
      voice_fallback_llm_model: 'synthetic-voice-fallback',
      voice_fallback_llm_model_parameters: { reasoning_effort: 'high' },
      glasshive_options: { access: 'full', fallback_model: 'synthetic-fallback' },
    };

    function pendingCompletion(overrides = {}) {
      const pending = row({
        surface: 'voice',
        destinations: [{ surface: 'voice', voiceCallSessionId: 'historical-call' }],
        terminalCallbackResultKey: `ghtr_${'a'.repeat(64)}`,
        terminalCallbackAcceptedOperationId: 'b'.repeat(32),
        terminalCallbackId: `cb_terminal_${'c'.repeat(64)}`,
        terminalCallbackResultDigest: `sha256:${'d'.repeat(64)}`,
        terminalCallbackResultRevision: 1,
        terminalCallbackEffectGeneration: 1,
        ...overrides,
      });
      mockFind.mockReturnValueOnce(cursor([pending]));
      mockFindOneAndUpdate.mockResolvedValueOnce({ ...pending, state: 'processing' });
      mockGetAgent.mockResolvedValue(savedAgent);
      return pending;
    }

    function voiceActive(input) {
      return jest.requireActual('../voiceLlmOverride').isVoiceCallActive(input.req);
    }

    test('propagates canonical Call context to the existing Voice activation consumer', async () => {
      pendingCompletion();
      const before = JSON.stringify(savedAgent);
      mockGetActiveCallSessionForConversation.mockResolvedValue({ callSessionId: 'live-call' });
      await expect(
        flushGlassHiveMissionAdjudications({ ownerId: 'user-1' }),
      ).resolves.toMatchObject({
        visible: 1,
        failed: 0,
      });
      const input = mockPrepareCortexFollowUpMessage.mock.calls[0][0];
      expect(input.req.body).toEqual({
        viventiumSurface: 'voice',
        voiceMode: true,
        viventiumInputMode: 'voice_call',
        viventiumCallSessionId: 'live-call',
      });
      expect(input.req.viventiumCallSession).toEqual({ callSessionId: 'live-call' });
      expect(require('@librechat/api').isAudioDeliveryRequested(input.req)).toBe(true);
      expect(voiceActive(input)).toBe(true);
      expect(input.agent).toEqual(savedAgent);
      expect(JSON.stringify(savedAgent)).toBe(before);
      expect(mockGetActiveCallSessionForConversation).toHaveBeenCalledTimes(2);
      expect(mockGetActiveCallSessionForConversation).toHaveBeenNthCalledWith(1, {
        userId: 'user-1',
        conversationId: 'conversation-1',
      });
    });

    test('overlaps the canonical Call lookup with validated user and agent reads', async () => {
      pendingCompletion();
      let userRequested;
      let releaseUser;
      let releaseAgent;
      const userStarted = new Promise((resolve) => {
        userRequested = resolve;
      });
      const userRead = new Promise((resolve) => {
        releaseUser = resolve;
      });
      const agentRead = new Promise((resolve) => {
        releaseAgent = resolve;
      });
      mockGetUserById.mockImplementationOnce(() => {
        userRequested();
        return userRead;
      });
      mockGetAgent.mockReturnValueOnce(agentRead);
      mockGetActiveCallSessionForConversation.mockResolvedValue({ callSessionId: 'live-call' });
      const flushing = flushGlassHiveMissionAdjudications({ ownerId: 'user-1' });
      try {
        await userStarted;
        expect(mockGetActiveCallSessionForConversation).toHaveBeenCalledTimes(1);
        expect(mockPrepareCortexFollowUpMessage).not.toHaveBeenCalled();
      } finally {
        releaseUser({ id: 'user-1', role: 'USER' });
        releaseAgent(savedAgent);
        await flushing;
      }
      expect(mockPrepareCortexFollowUpMessage).toHaveBeenCalledTimes(1);
    });

    test('preserves an unset Voice assignment for the existing Main inheritance', async () => {
      pendingCompletion();
      mockGetAgent.mockResolvedValue({
        ...savedAgent,
        voice_llm_provider: '',
        voice_llm_model: '',
      });
      mockGetActiveCallSessionForConversation.mockResolvedValue({ callSessionId: 'live-call' });
      await flushGlassHiveMissionAdjudications({ ownerId: 'user-1' });
      const input = mockPrepareCortexFollowUpMessage.mock.calls[0][0];
      expect(voiceActive(input)).toBe(true);
      expect(input.agent).toMatchObject({
        provider: savedAgent.provider,
        model: savedAgent.model,
        voice_llm_provider: '',
        voice_llm_model: '',
        model_parameters: { reasoning_effort: 'high' },
      });
    });

    test.each(['web', 'telegram', 'wing'])(
      'keeps %s synthesis on the Main route without a Call lookup',
      async (surface) => {
        pendingCompletion({ surface, destinations: [{ surface }] });
        await flushGlassHiveMissionAdjudications({ ownerId: 'user-1' });
        const input = mockPrepareCortexFollowUpMessage.mock.calls[0][0];
        expect(input.req.body).toEqual({ viventiumSurface: surface });
        expect(voiceActive(input)).toBe(false);
        expect(mockGetActiveCallSessionForConversation).not.toHaveBeenCalled();
      },
    );

    test('a Voice destination alone cannot select the Voice brain without an eligible canonical Call', async () => {
      pendingCompletion();
      mockGetActiveCallSessionForConversation.mockResolvedValue(null);
      await flushGlassHiveMissionAdjudications({ ownerId: 'user-1' });
      const input = mockPrepareCortexFollowUpMessage.mock.calls[0][0];
      expect(input.req.body).toEqual({ viventiumSurface: 'voice' });
      expect(voiceActive(input)).toBe(false);
      expect(input.req.viventiumCallSession).toBeUndefined();
      expect(require('@librechat/api').isAudioDeliveryRequested(input.req)).toBe(false);
      expect(mockEnqueueDelivery.mock.calls[0][0].deliveryContext.destinations).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ surface: 'voice' })]),
      );
    });

    test('checks the resolved account continuation instead of an ended origin conversation', async () => {
      pendingCompletion();
      mockGetConvo.mockResolvedValue(null);
      mockGetActiveCallSessionForConversation.mockImplementation(async ({ conversationId }) =>
        conversationId === 'conversation-1' ? { callSessionId: 'origin-call' } : null,
      );
      await flushGlassHiveMissionAdjudications({ ownerId: 'user-1' });
      const input = mockPrepareCortexFollowUpMessage.mock.calls[0][0];
      expect(input.conversationId).not.toBe('conversation-1');
      expect(mockGetActiveCallSessionForConversation).toHaveBeenNthCalledWith(1, {
        userId: 'user-1',
        conversationId: input.conversationId,
      });
      expect(input.req.body).toEqual({ viventiumSurface: 'voice' });
      expect(voiceActive(input)).toBe(false);
      expect(input.req.viventiumCallSession).toBeUndefined();
      expect(require('@librechat/api').isAudioDeliveryRequested(input.req)).toBe(false);
    });

    test('rechecks delivery after the Call ends during synthesis and retains linked text', async () => {
      pendingCompletion();
      mockGetActiveCallSessionForConversation
        .mockResolvedValueOnce({ callSessionId: 'live-call' })
        .mockResolvedValueOnce(null);
      await expect(
        flushGlassHiveMissionAdjudications({ ownerId: 'user-1' }),
      ).resolves.toMatchObject({
        visible: 1,
        failed: 0,
      });
      expect(voiceActive(mockPrepareCortexFollowUpMessage.mock.calls[0][0])).toBe(true);
      expect(mockGetActiveCallSessionForConversation).toHaveBeenCalledTimes(2);
      const delivered = mockEnqueueDelivery.mock.calls[0][0];
      expect(delivered.deliveryContext.workerCompletionPresentation).toBeUndefined();
      expect(delivered.deliveryContext.destinations).toEqual([{ surface: 'librechat' }]);
      expect(mockStoredMessages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            messageId: 'follow-up-1',
            text: 'Main-authored synthetic follow-up.',
          }),
        ]),
      );
    });

    test('delivery uses the current reconnected Call rather than reusing the synthesis snapshot', async () => {
      pendingCompletion();
      mockGetActiveCallSessionForConversation
        .mockResolvedValueOnce({ callSessionId: 'first-call' })
        .mockResolvedValueOnce({ callSessionId: 'reconnected-call' });
      await flushGlassHiveMissionAdjudications({ ownerId: 'user-1' });
      expect(
        mockPrepareCortexFollowUpMessage.mock.calls[0][0].req.body.viventiumCallSessionId,
      ).toBe('first-call');
      expect(
        mockEnqueueDelivery.mock.calls[0][0].deliveryContext.workerCompletionPresentation
          .callSessionId,
      ).toBe('reconnected-call');
    });
  });

  test('pre-attempt cancellation cannot abort a grouped result during an active call', async () => {
    const telegram = { surface: 'telegram', telegramChatId: 'chat-1' };
    const terminal = (suffix, overrides = {}) =>
      row({
        _id: `cb-${suffix}`,
        evidenceId: `cb-${suffix}`,
        originRef: `origin-${suffix}`,
        workRef: `work-${suffix}`,
        workerId: `worker-${suffix}`,
        runId: `run-${suffix}`,
        callbackRef: canonicalCallbackRef(`cb_terminal_${suffix.repeat(64)}`),
        attemptNumber: 1,
        surface: 'voice',
        destinations: [{ surface: 'voice', voiceCallSessionId: 'live-call' }, telegram],
        terminalCallbackResultKey: `ghtr_${suffix.repeat(64)}`,
        terminalCallbackAcceptedOperationId: suffix.repeat(32),
        terminalCallbackId: `cb_terminal_${suffix.repeat(64)}`,
        terminalCallbackResultDigest: `sha256:${suffix.repeat(64)}`,
        terminalCallbackResultRevision: 1,
        terminalCallbackEffectGeneration: 1,
        ...overrides,
      });
    const rows = [
      terminal('a', {
        event: 'run.cancelled',
        workState: 'cancelled',
        workTerminal: true,
        attemptNumber: null,
        evidence: 'Stopped before dispatch; the draft is retained.',
      }),
      terminal('b'),
    ];
    mockFind.mockReturnValueOnce(cursor(rows));
    mockFindOneAndUpdate.mockImplementation(async (filter) => ({
      ...rows.find((item) => item._id === filter._id),
      state: 'processing',
    }));
    mockGetActiveCallSessionForConversation.mockResolvedValue({
      callSessionId: 'live-call',
      userId: 'user-1',
      conversationId: 'conversation-1',
      status: 'listening',
    });
    await expect(flushGlassHiveMissionAdjudications({ ownerId: 'user-1' })).resolves.toMatchObject({
      visible: 2,
      failed: 0,
    });
    expect(mockCreateCortexFollowUpMessage).toHaveBeenCalledTimes(1);
    expect(mockEnqueueDelivery).toHaveBeenCalledTimes(1);
    const delivered = mockEnqueueDelivery.mock.calls[0][0];
    expect(delivered.deliveryContext.destinations).toEqual(expect.arrayContaining([telegram]));
    expect(delivered.deliveryContext.destinations.some((item) => item.surface === 'voice')).toBe(
      false,
    );
    expect(delivered.deliveryContext.workerCompletionPresentation).toBeUndefined();
  });

  test('ended Call completion keeps the authored linked result and other destinations without regeneration', async () => {
    const telegram = { surface: 'telegram', telegramChatId: 'chat-1' };
    const retained = row({
      surface: 'voice',
      state: 'delivery_pending',
      destinations: [{ surface: 'voice', voiceCallSessionId: 'ended-call' }, telegram],
      followUpMessageId: 'already-authored-result',
      followUpText: 'The useful guide is ready.',
    });
    retainAuthoredFollowUp(retained);
    mockFind.mockReturnValueOnce(cursor([retained]));
    mockFindOneAndUpdate.mockResolvedValueOnce({ ...retained, state: 'processing' });
    mockEnqueueDelivery.mockImplementationOnce(async ({ deliveryContext }) => ({
      configured: deliveryContext.destinations.length,
      enqueued: deliveryContext.destinations.filter((item) => item.surface === 'telegram').length,
      unresolved: deliveryContext.destinations.filter((item) => item.surface === 'voice').length,
    }));
    await expect(flushGlassHiveMissionAdjudications({ ownerId: 'user-1' })).resolves.toEqual(
      expect.objectContaining({ visible: 1, failed: 0 }),
    );
    expect(mockPrepareCortexFollowUpMessage).not.toHaveBeenCalled();
    expect(mockCreateCortexFollowUpMessage).not.toHaveBeenCalled();
    expect(mockEnqueueDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        message: {
          messageId: 'already-authored-result',
          text: 'The useful guide is ready.',
          user: retained.ownerId,
          conversationId: retained.accountContinuationConversationId || retained.conversationId,
          isCreatedByUser: false,
        },
        deliveryContext: expect.objectContaining({
          destinations: [telegram, { surface: 'librechat' }],
        }),
      }),
    );
    expect(mockRecordTraceDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: 'user-1',
        originRef: 'ghi-origin-1',
        workRef: 'gh-work-1',
        runRef: 'run-1',
        deliveryRef: 'main-web:already-authored-result',
        surface: 'web',
        status: 'sent',
      }),
    );
  });

  test('records an exact Web receipt only after Main persists the visible presentation', async () => {
    const callbackRef = canonicalCallbackRef('cb-web-exact');
    const webRow = row({
      callbackRef,
      attemptNumber: 4,
      surface: 'web',
      destinations: [{ surface: 'librechat' }],
    });
    mockFind.mockReturnValueOnce(cursor([webRow]));
    mockFindOneAndUpdate.mockResolvedValueOnce({ ...webRow, state: 'processing' });
    mockCreateCortexFollowUpMessage.mockResolvedValueOnce({
      messageId: 'follow-up-web-exact',
      text: 'Main-authored visible result.',
    });

    await expect(flushGlassHiveMissionAdjudications({ ownerId: 'user-1' })).resolves.toEqual(
      expect.objectContaining({ visible: 1, failed: 0 }),
    );

    expect(mockRecordTraceDelivery).toHaveBeenCalledTimes(1);
    expect(mockRecordTraceDelivery).toHaveBeenCalledWith({
      ownerId: 'user-1',
      originRef: 'ghi-origin-1',
      deliveryRef: 'main-web:follow-up-web-exact',
      workRef: 'gh-work-1',
      runRef: 'run-1',
      callbackRef,
      callbackEvent: 'run.completed',
      state: 'completed',
      terminal: true,
      surface: 'web',
      status: 'sent',
      at: expect.any(Date),
      attemptNumber: 4,
    });
  });

  test('records an exact pre-runtime Stop Web receipt without an attempt', async () => {
    const callbackRef = canonicalCallbackRef('cb-web-pre-runtime-stop');
    const webRow = row({
      callbackRef,
      attemptNumber: null,
      event: 'run.cancelled',
      workState: 'cancelled',
      workTerminal: true,
      surface: 'web',
      destinations: [{ surface: 'librechat' }],
    });
    mockFind.mockReturnValueOnce(cursor([webRow]));
    mockFindOneAndUpdate.mockResolvedValueOnce({ ...webRow, state: 'processing' });
    mockCreateCortexFollowUpMessage.mockResolvedValueOnce({
      messageId: 'follow-up-web-pre-runtime-stop',
      text: 'Mission stopped.',
    });

    await flushGlassHiveMissionAdjudications({ ownerId: 'user-1' });

    expect(mockRecordTraceDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        callbackRef,
        callbackEvent: 'run.cancelled',
        state: 'cancelled',
        terminal: true,
        attemptNumber: null,
        deliveryRef: 'main-web:follow-up-web-pre-runtime-stop',
      }),
    );
  });

  test.each([
    ['missing callback ref', { callbackRef: '' }],
    ['raw callback ref', { callbackRef: 'cb-raw' }],
    ['missing attempt', { attemptNumber: undefined }],
    ['invalid attempt', { attemptNumber: 0 }],
  ])('does not record a Web receipt with %s', async (_label, overrides) => {
    const invalidRow = row({
      surface: 'web',
      destinations: [{ surface: 'librechat' }],
      ...overrides,
    });
    mockFind.mockReturnValueOnce(cursor([invalidRow]));
    mockFindOneAndUpdate.mockResolvedValueOnce({ ...invalidRow, state: 'processing' });
    mockCreateCortexFollowUpMessage.mockResolvedValueOnce({
      messageId: 'follow-up-web-invalid',
      text: 'Visible but not trace-bound.',
    });

    await flushGlassHiveMissionAdjudications({ ownerId: 'user-1' });

    expect(mockRecordTraceDelivery).not.toHaveBeenCalled();
  });

  test('reuses the durable Web presentation receipt across restart recovery', async () => {
    const callbackRef = canonicalCallbackRef('cb-web-restart');
    const presentedAt = new Date('2026-08-22T14:00:00.000Z');
    const recovered = row({
      callbackRef,
      attemptNumber: 2,
      surface: 'web',
      destinations: [{ surface: 'librechat' }],
      followUpMessageId: 'follow-up-web-restart',
      followUpText: 'Recovered Main result.',
      webPresentationMessageId: 'follow-up-web-restart',
      webPresentedAt: presentedAt,
    });
    retainAuthoredFollowUp(recovered);
    mockFind.mockReturnValueOnce(cursor([recovered]));
    mockFindOneAndUpdate.mockResolvedValueOnce({ ...recovered, state: 'processing' });

    await flushGlassHiveMissionAdjudications({ ownerId: 'user-1' });

    expect(mockCreateCortexFollowUpMessage).not.toHaveBeenCalled();
    expect(mockRecordTraceDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        callbackRef,
        attemptNumber: 2,
        deliveryRef: 'main-web:follow-up-web-restart',
        at: presentedAt,
      }),
    );
  });

  test('failed Main presentation creates no surface receipt', async () => {
    const webRow = row({ surface: 'web', destinations: [{ surface: 'librechat' }] });
    mockFind.mockReturnValueOnce(cursor([webRow]));
    mockFindOneAndUpdate.mockResolvedValueOnce({ ...webRow, state: 'processing' });
    mockCreateCortexFollowUpMessage.mockRejectedValueOnce(new Error('synthetic presentation fail'));

    await flushGlassHiveMissionAdjudications({ ownerId: 'user-1' });

    expect(mockRecordTraceDelivery).not.toHaveBeenCalled();
  });

  test('recovers a legacy binding with the configured Main agent identity', async () => {
    process.env.VIVENTIUM_MAIN_AGENT_ID = 'configured-main-agent';
    const legacyRow = row({ mainAgentId: '' });
    mockFind.mockReturnValueOnce(cursor([legacyRow]));
    mockFindOneAndUpdate.mockResolvedValueOnce({ ...legacyRow, state: 'processing' });
    mockGetAgent.mockResolvedValueOnce({ id: 'configured-main-agent', provider: 'openAI' });

    await expect(flushGlassHiveMissionAdjudications({ ownerId: 'user-1' })).resolves.toEqual({
      claimed: 1,
      groups: 1,
      visible: 1,
      silent: 0,
      failed: 0,
    });

    expect(mockGetAgent).toHaveBeenCalledWith({ id: 'configured-main-agent' });
    expect(mockCreateCortexFollowUpMessage).toHaveBeenCalledWith(
      expect.objectContaining({ agent: expect.objectContaining({ id: 'configured-main-agent' }) }),
    );
    delete process.env.VIVENTIUM_MAIN_AGENT_ID;
  });

  test('rebuilds the authenticated request id alias from a lean persisted user', async () => {
    const leanUser = { _id: 'user-1', role: 'USER' };
    mockGetUserById.mockResolvedValueOnce(leanUser);
    mockFind.mockReturnValueOnce(cursor([row()]));

    await expect(flushGlassHiveMissionAdjudications({ ownerId: 'user-1' })).resolves.toEqual(
      expect.objectContaining({ visible: 1, failed: 0 }),
    );

    expect(mockCreateCortexFollowUpMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        req: expect.objectContaining({
          user: expect.objectContaining({ _id: 'user-1', id: 'user-1', role: 'USER' }),
        }),
      }),
    );
    expect(leanUser).toEqual({ _id: 'user-1', role: 'USER' });
  });

  test('does not deliver fallback prose when the mission synthesis provider failed', async () => {
    mockFind.mockReturnValueOnce(cursor([row()]));
    mockPrepareCortexFollowUpMessage.mockResolvedValueOnce({
      text: 'Generic fallback prose.',
      followUpDecisionRecord: { generationFailed: true, forceVisibleFollowUp: true },
    });
    await expect(flushGlassHiveMissionAdjudications({ ownerId: 'user-1' })).resolves.toEqual(
      expect.objectContaining({ failed: 1, silent: 0, visible: 0 }),
    );
    expect(mockPersistPreparedCortexFollowUpMessage).not.toHaveBeenCalled();
    expect(mockEnqueueDelivery).not.toHaveBeenCalled();
    expect(mockMessageUpdateOne).not.toHaveBeenCalled();
    expect(mockRecordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'failed',
        errorCode: 'mission_synthesis_generation_failed',
      }),
    );
  });

  test('mission Main can select a retained File grant without row or new native output files', async () => {
    const previous = process.env.GLASSHIVE_ARTIFACT_BASE_URL;
    process.env.GLASSHIVE_ARTIFACT_BASE_URL = 'https://native.example.test';
    const retained = '[Capture](https://native.example.test/v1/link-refs/ghr_retained1234567890)';
    const queued = row();
    mockFind.mockReturnValueOnce(cursor([queued]));
    mockFindOneAndUpdate.mockResolvedValueOnce({ ...queued, state: 'processing' });
    const attachments = [{ file_id: 'owned-file', filepath: '/uploads/capture.svg' }];
    mockPrepareMissionOutputFiles.mockResolvedValueOnce(attachments);
    mockPersistPreparedCortexFollowUpMessage.mockImplementationOnce(async (input) => {
      const message = {
        conversationId: input.conversationId,
        messageId: 'actual-main-message',
        agent_id: input.agent.id,
        text: retained,
      };
      message.attachments = await input.dependencies.prepareAttachments(message);
      return storeAuthoredMessage(input, message);
    });
    try {
      await expect(
        flushGlassHiveMissionAdjudications({ ownerId: 'user-1' }),
      ).resolves.toMatchObject({ visible: 1, failed: 0 });
      expect(mockPrepareMissionOutputFiles).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.objectContaining({ text: retained, messageId: 'actual-main-message' }),
        }),
      );
    } finally {
      if (previous === undefined) delete process.env.GLASSHIVE_ARTIFACT_BASE_URL;
      else process.env.GLASSHIVE_ARTIFACT_BASE_URL = previous;
    }
  });
  test.each(['nta', 'native_silent'])(
    'retains explicit semantic %s as silent inside the accepted-result fence',
    async (kind) => {
      const fenced = row({
        terminalCallbackResultKey: `ghtr_${'a'.repeat(64)}`,
        terminalCallbackAcceptedOperationId: 'b'.repeat(32),
        terminalCallbackId: `cb_terminal_${'c'.repeat(64)}`,
        terminalCallbackResultDigest: `sha256:${'d'.repeat(64)}`,
        terminalCallbackResultRevision: 1,
        terminalCallbackEffectGeneration: 1,
      });
      mockFind.mockReturnValueOnce(cursor([fenced]));
      mockFindOneAndUpdate.mockResolvedValueOnce({ ...fenced, state: 'processing' });
      const activeSession = { id: 'silent-result-session' };
      mockRunTransaction = async (operation) => {
        mockTransactionSession = activeSession;
        try {
          return await operation(activeSession);
        } finally {
          mockTransactionSession = null;
        }
      };
      mockPrepareCortexFollowUpMessage.mockResolvedValueOnce({
        followUpDecisionRecord: {
          generationFailed: false,
          forceVisibleFollowUp: false,
          llmResult: kind,
          ...(kind === 'native_silent' ? { nativeSilentDecision: true } : {}),
          selectedStrategy: kind === 'nta' ? 'no_response_suppressed' : 'native_silent_suppressed',
        },
      });
      mockCreateCortexFollowUpMessage.mockResolvedValueOnce(null);

      await expect(flushGlassHiveMissionAdjudications({ ownerId: 'user-1' })).resolves.toEqual(
        expect.objectContaining({ silent: 1, visible: 0, failed: 0 }),
      );
      expect(mockRecordOutcome).toHaveBeenCalledWith(
        expect.objectContaining({
          originRef: 'ghi-origin-1',
          state: 'silent',
          followUpMessageId: '',
          errorCode: '',
        }),
      );
      expect(mockEnqueueDelivery).not.toHaveBeenCalled();
      expect(mockMessageUpdateOne).toHaveBeenCalledTimes(1);
      expect(mockMessageUpdateOne).toHaveBeenCalledWith(
        {
          user: 'user-1',
          conversationId: 'conversation-1',
          isCreatedByUser: false,
          'metadata.viventium.type': 'glasshive_worker_callback',
          'metadata.viventium.originRef': 'ghi-origin-1',
          'metadata.viventium.runId': 'run-1',
          'metadata.viventium.callbackId': fenced.terminalCallbackId,
          'metadata.viventium.status.kind': 'mission_status',
          'metadata.viventium.status.state': 'completed',
          'metadata.viventium.hasFullText': false,
        },
        { $set: { 'metadata.viventium.visibility': 'internal' } },
        { session: activeSession },
      );
    },
  );

  test.each([
    { generationFailed: true },
    { forceVisibleFollowUp: true },
    { llmResult: 'empty' },
    { selectedStrategy: 'voice_empty_suppressed' },
  ])('does not mistake an unavailable presentation for semantic silence: %o', async (changed) => {
    mockFind.mockReturnValueOnce(cursor([row()]));
    mockPrepareCortexFollowUpMessage.mockResolvedValueOnce({
      followUpDecisionRecord: {
        generationFailed: false,
        forceVisibleFollowUp: false,
        llmResult: 'nta',
        selectedStrategy: 'no_response_suppressed',
        ...changed,
      },
    });
    mockCreateCortexFollowUpMessage.mockResolvedValueOnce(null);
    await expect(flushGlassHiveMissionAdjudications({ ownerId: 'user-1' })).resolves.toEqual(
      expect.objectContaining({ silent: 0, visible: 0, failed: 1 }),
    );
    expect(mockEnqueueDelivery).not.toHaveBeenCalled();
    expect(mockMessageUpdateOne).not.toHaveBeenCalled();
  });

  test('does not silently discard first terminal evidence when Main returns no presentation', async () => {
    mockFind.mockReturnValueOnce(cursor([row()]));
    mockCreateCortexFollowUpMessage.mockResolvedValueOnce(null);

    await expect(flushGlassHiveMissionAdjudications({ ownerId: 'user-1' })).resolves.toEqual(
      expect.objectContaining({ silent: 0, visible: 0, failed: 1 }),
    );
    expect(mockRecordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        originRef: 'ghi-origin-1',
        state: 'failed',
        errorCode: 'mission_terminal_presentation_missing',
      }),
    );
    expect(mockCreateCortexFollowUpMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        forceVisibleFollowUp: true,
        allowMovedOnUsefulFollowUp: true,
      }),
    );
    expect(mockEnqueueDelivery).not.toHaveBeenCalled();
  });

  test('routes an archived origin through Main with the moved-on useful-result exemption', async () => {
    mockFind.mockReturnValueOnce(cursor([row()]));
    mockGetConvo.mockResolvedValueOnce({
      conversationId: 'conversation-1',
      user: 'user-1',
      archived: true,
    });

    await expect(flushGlassHiveMissionAdjudications({ ownerId: 'user-1' })).resolves.toEqual(
      expect.objectContaining({ visible: 1, silent: 0, failed: 0 }),
    );
    expect(mockCreateCortexFollowUpMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conversation-1',
        parentMessageId: 'assistant-anchor',
        forceVisibleFollowUp: true,
        allowMovedOnUsefulFollowUp: true,
      }),
    );
  });

  test('isolates a deleted-origin delivery ledger from a stale global sentinel parent', async () => {
    const noParentMessageId = '00000000-0000-0000-0000-000000000000';
    const deletedOrigin = row({
      _id: 'cb-deleted-isolated-parent',
      evidenceId: 'cb-deleted-isolated-parent',
    });
    mockFind
      .mockReturnValueOnce(cursor([deletedOrigin]))
      .mockReturnValueOnce(cursor([deletedOrigin]));
    mockFindOneAndUpdate.mockImplementation(async () => ({
      ...deletedOrigin,
      state: 'processing',
    }));
    mockGetConvo.mockResolvedValue(null);

    let pinnedDeliveryParentMessageId = '';
    mockCreateCortexFollowUpMessage
      .mockImplementationOnce(async (input) => {
        if (input.deliveryParentMessageId === noParentMessageId) {
          throw Object.assign(new Error('synthetic stale sentinel collision'), {
            code: 'cortex_insight_delivery_batch_mixed_envelope',
          });
        }
        pinnedDeliveryParentMessageId = input.deliveryParentMessageId;
        throw Object.assign(new Error('synthetic provider outage after the delivery pin'), {
          code: 'provider_unavailable',
        });
      })
      .mockImplementationOnce(async (input) => {
        expect(input.deliveryParentMessageId).toBe(pinnedDeliveryParentMessageId);
        return { messageId: 'follow-up-deleted-isolated-parent', text: 'Recovered result.' };
      });

    await expect(flushGlassHiveMissionAdjudications({ ownerId: 'user-1' })).resolves.toEqual(
      expect.objectContaining({ failed: 1, visible: 0 }),
    );
    await expect(flushGlassHiveMissionAdjudications({ ownerId: 'user-1' })).resolves.toEqual(
      expect.objectContaining({ failed: 0, visible: 1 }),
    );

    expect(pinnedDeliveryParentMessageId).toMatch(/^ghdp_[a-f0-9]{64}$/);
    expect(pinnedDeliveryParentMessageId).not.toBe(noParentMessageId);
    for (const [input] of mockCreateCortexFollowUpMessage.mock.calls) {
      expect(input.parentMessageId).toBe(noParentMessageId);
    }
  });

  test('settles cleanup-tombstoned origin evidence without synthesis or a new continuation', async () => {
    mockFind.mockReturnValueOnce(cursor([row()]));
    mockConversationFindOne.mockResolvedValue({ _id: 'cleanup-origin' });
    mockGetConvo.mockResolvedValue(null);

    await expect(flushGlassHiveMissionAdjudications({ ownerId: 'user-1' })).resolves.toEqual(
      expect.objectContaining({ silent: 1, visible: 0, failed: 0 }),
    );

    expect(mockConversationFindOne).toHaveBeenCalledWith(
      {
        user: 'user-1',
        conversationId: 'conversation-1',
        deletedAt: { $type: 'date' },
        'cleanupTombstone.operationId': { $type: 'string', $ne: '' },
        'cleanupTombstone.tombstonedAt': { $type: 'date' },
      },
      { projection: { _id: 1 } },
    );
    expect(mockPrepareCortexFollowUpMessage).not.toHaveBeenCalled();
    expect(mockPersistPreparedCortexFollowUpMessage).not.toHaveBeenCalled();
    expect(mockSaveConvo).not.toHaveBeenCalled();
    expect(mockEnqueueDelivery).not.toHaveBeenCalled();
    expect(mockRecordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'silent', errorCode: 'mission_origin_cleanup_tombstoned' }),
    );
  });

  test('rechecks a cleanup tombstone after synthesis within the authored transaction', async () => {
    const fenced = row({
      terminalCallbackResultKey: `ghtr_${'a'.repeat(64)}`,
      terminalCallbackAcceptedOperationId: 'b'.repeat(32),
      terminalCallbackId: `cb_terminal_${'c'.repeat(64)}`,
      terminalCallbackResultDigest: `sha256:${'d'.repeat(64)}`,
      terminalCallbackResultRevision: 1,
      terminalCallbackEffectGeneration: 1,
    });
    mockFind.mockReturnValueOnce(cursor([fenced]));
    mockFindOneAndUpdate.mockResolvedValueOnce({ ...fenced, state: 'processing' });
    const activeSession = { id: 'synthetic-cleanup-session' };
    mockRunTransaction = async (operation) => {
      mockTransactionSession = activeSession;
      try {
        return await operation(activeSession);
      } finally {
        mockTransactionSession = null;
      }
    };
    mockConversationFindOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ _id: 'cleanup-origin' });

    await expect(flushGlassHiveMissionAdjudications({ ownerId: 'user-1' })).resolves.toEqual(
      expect.objectContaining({ silent: 1, visible: 0, failed: 0 }),
    );

    expect(mockPrepareCortexFollowUpMessage).toHaveBeenCalledTimes(1);
    expect(mockConversationFindOne).toHaveBeenLastCalledWith(
      expect.objectContaining({ user: 'user-1', conversationId: 'conversation-1' }),
      { projection: { _id: 1 }, session: activeSession },
    );
    expect(mockPersistPreparedCortexFollowUpMessage).not.toHaveBeenCalled();
    expect(mockSaveConvo).not.toHaveBeenCalled();
    expect(mockEnqueueDelivery).not.toHaveBeenCalled();
    expect(mockRecordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'silent', errorCode: 'mission_origin_cleanup_tombstoned' }),
    );
  });

  test('suppresses an anchor cleanup tombstone inside a live personal conversation', async () => {
    mockFind.mockReturnValueOnce(cursor([row()]));
    mockMessageFindOne.mockImplementation(async (filter) =>
      filter.messageId === 'assistant-anchor' && filter.deletedAt?.$type === 'date'
        ? { _id: 'cleanup-anchor' }
        : null,
    );

    await expect(flushGlassHiveMissionAdjudications({ ownerId: 'user-1' })).resolves.toEqual(
      expect.objectContaining({ silent: 1, visible: 0, failed: 0 }),
    );

    expect(mockMessageFindOne).toHaveBeenCalledWith(
      expect.objectContaining({
        user: 'user-1',
        conversationId: 'conversation-1',
        messageId: 'assistant-anchor',
        deletedAt: { $type: 'date' },
        'cleanupTombstone.operationId': { $type: 'string', $ne: '' },
        'cleanupTombstone.tombstonedAt': { $type: 'date' },
      }),
      { projection: { _id: 1 } },
    );
    expect(mockPrepareCortexFollowUpMessage).not.toHaveBeenCalled();
    expect(mockPersistPreparedCortexFollowUpMessage).not.toHaveBeenCalled();
    expect(mockSaveConvo).not.toHaveBeenCalled();
    expect(mockEnqueueDelivery).not.toHaveBeenCalled();
  });

  test('keeps a foreign-owner cleanup tombstone outside this mission scope', async () => {
    mockFind.mockReturnValueOnce(cursor([row()]));
    mockConversationFindOne.mockImplementation(async (filter) =>
      filter.user === 'other-user' ? { _id: 'foreign-cleanup-origin' } : null,
    );
    mockGetConvo.mockResolvedValue(null);

    await expect(flushGlassHiveMissionAdjudications({ ownerId: 'user-1' })).resolves.toEqual(
      expect.objectContaining({ visible: 1, silent: 0, failed: 0 }),
    );
    expect(mockConversationFindOne).toHaveBeenCalledWith(
      expect.objectContaining({ user: 'user-1', conversationId: 'conversation-1' }),
      { projection: { _id: 1 } },
    );
    expect(mockSaveConvo).toHaveBeenCalledTimes(1);
  });

  test('settles a legacy redrive from a cleanup-tombstoned origin without replaying it', async () => {
    const legacy = row({
      _id: 'ghe_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      evidenceId: 'ghe_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      state: 'deadletter',
      attempts: 10,
      errorCode: 'mission_adjudication_retry_exhausted',
      adjudicationGroupId: 'ghag_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      adjudicationGroupMemberIds: ['ghe_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
      terminalCallbackResultKey: `ghtr_${'c'.repeat(64)}`,
      terminalCallbackAcceptedOperationId: 'd'.repeat(32),
      terminalCallbackId: `cb_terminal_${'e'.repeat(64)}`,
      terminalCallbackResultDigest: `sha256:${'f'.repeat(64)}`,
      terminalCallbackResultRevision: 1,
      terminalCallbackEffectGeneration: 1,
    });
    mockFind.mockReturnValueOnce(cursor([legacy]));
    mockGetConvo.mockResolvedValue(null);
    mockUpdateOne.mockResolvedValue({ acknowledged: true, matchedCount: 1, modifiedCount: 1 });
    await expect(redriveLegacyDeletedOriginMissionAdjudications()).resolves.toEqual(
      expect.objectContaining({ redriven: 1, failed: 0 }),
    );
    const redriven = { ...legacy, state: 'pending', attempts: 0 };
    mockFind.mockReturnValueOnce(cursor([redriven]));
    mockFindOneAndUpdate.mockResolvedValueOnce({ ...redriven, state: 'processing' });
    mockConversationFindOne.mockResolvedValue({ _id: 'cleanup-origin' });

    await expect(flushGlassHiveMissionAdjudications({ ownerId: 'user-1' })).resolves.toEqual(
      expect.objectContaining({ silent: 1, visible: 0, failed: 0 }),
    );
    mockFind.mockReturnValueOnce(cursor([]));
    await expect(flushGlassHiveMissionAdjudications({ ownerId: 'user-1' })).resolves.toEqual(
      expect.objectContaining({ claimed: 0, visible: 0, failed: 0 }),
    );
    expect(mockRecordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'silent', errorCode: 'mission_origin_cleanup_tombstoned' }),
    );
    expect(mockPrepareCortexFollowUpMessage).not.toHaveBeenCalled();
    expect(mockSaveConvo).not.toHaveBeenCalled();
    expect(mockEnqueueDelivery).not.toHaveBeenCalled();
  });

  test('uses a new account continuation when the origin conversation was deleted', async () => {
    mockFind.mockReturnValueOnce(cursor([row()]));
    mockGetConvo.mockResolvedValue(null);
    mockCreateCortexFollowUpMessage.mockResolvedValueOnce({
      messageId: 'follow-up-account-1',
      text: 'Main-authored account continuation.',
    });

    await expect(flushGlassHiveMissionAdjudications({ ownerId: 'user-1' })).resolves.toEqual(
      expect.objectContaining({ visible: 1, failed: 0 }),
    );

    const phaseBInput = mockCreateCortexFollowUpMessage.mock.calls[0][0];
    expect(phaseBInput.conversationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(phaseBInput.conversationId).not.toBe('conversation-1');
    expect(phaseBInput.parentMessageId).toBe('00000000-0000-0000-0000-000000000000');
    expect(mockSaveConvo).toHaveBeenCalledWith(
      expect.objectContaining({ user: expect.objectContaining({ id: 'user-1' }) }),
      expect.objectContaining({
        conversationId: phaseBInput.conversationId,
        title: 'Background work',
        endpoint: 'agents',
      }),
      expect.objectContaining({ context: expect.stringContaining('accountContinuation') }),
    );
    expect(mockSaveConvo).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ conversationId: 'conversation-1' }),
      expect.anything(),
    );
    expect(mockEnqueueDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryContext: expect.objectContaining({
          conversationId: phaseBInput.conversationId,
          anchorMessageId: '00000000-0000-0000-0000-000000000000',
        }),
      }),
    );
    expect(mockUpdateOne).toHaveBeenCalledWith(
      { _id: 'cb-1', state: 'processing' },
      expect.objectContaining({
        $set: expect.objectContaining({
          accountContinuationConversationId: phaseBInput.conversationId,
          accountContinuationAnchorMessageId: '00000000-0000-0000-0000-000000000000',
        }),
      }),
    );
  });

  test('keeps deleted-origin terminal evidence retryable when Main returns no presentation', async () => {
    mockFind.mockReturnValueOnce(cursor([row()]));
    mockGetConvo.mockResolvedValueOnce(null);
    mockCreateCortexFollowUpMessage.mockResolvedValueOnce(null);

    await expect(flushGlassHiveMissionAdjudications({ ownerId: 'user-1' })).resolves.toEqual(
      expect.objectContaining({ silent: 0, failed: 1 }),
    );

    expect(mockSaveConvo).not.toHaveBeenCalled();
    expect(mockRecordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'failed',
        errorCode: 'mission_terminal_presentation_missing',
      }),
    );
  });

  test('leaves failed synthesis durably retryable and exposes a restart reconciliation seam', async () => {
    mockFind.mockReturnValueOnce(cursor([row()]));
    mockCreateCortexFollowUpMessage.mockRejectedValueOnce(
      Object.assign(new Error('synthetic outage'), { code: 'provider_unavailable' }),
    );

    await expect(flushGlassHiveMissionAdjudications({ ownerId: 'user-1' })).resolves.toEqual(
      expect.objectContaining({ failed: 1 }),
    );
    expect(mockUpdateOne).toHaveBeenCalledWith(
      { _id: 'cb-1', state: 'processing' },
      expect.objectContaining({
        $set: expect.objectContaining({ state: 'failed', errorCode: 'provider_unavailable' }),
      }),
    );

    mockFind
      .mockReturnValueOnce(cursor([]))
      .mockReturnValueOnce(cursor([]))
      .mockReturnValueOnce(cursor([row({ state: 'failed', nextAttemptAt: new Date(0) })]));
    await expect(reconcilePendingGlassHiveMissionAdjudications()).resolves.toEqual({
      rows: 1,
      owners: 1,
    });
    expect(mockUpdateOne).toHaveBeenCalledWith(
      { _id: 'cb-1', state: 'failed' },
      expect.objectContaining({ $set: expect.objectContaining({ state: 'pending' }) }),
    );

    const recovered = row({ state: 'pending' });
    mockFind.mockReturnValueOnce(cursor([recovered]));
    mockFindOneAndUpdate.mockResolvedValueOnce({ ...recovered, state: 'processing' });
    mockCreateCortexFollowUpMessage.mockResolvedValueOnce({
      messageId: 'follow-up-after-restart',
      text: 'Main-authored useful result after restart.',
    });
    await expect(flushGlassHiveMissionAdjudications({ ownerId: 'user-1' })).resolves.toEqual(
      expect.objectContaining({ visible: 1, failed: 0 }),
    );
    expect(mockCreateCortexFollowUpMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ allowMovedOnUsefulFollowUp: true }),
    );
  });

  test('redrives one exact deleted-origin legacy deadletter behind its terminal fence', async () => {
    const evidenceId = 'ghe_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const candidate = row({
      _id: evidenceId,
      evidenceId,
      state: 'deadletter',
      attempts: 10,
      errorCode: 'mission_adjudication_retry_exhausted',
      adjudicationGroupId: 'ghag_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      adjudicationGroupMemberIds: [evidenceId],
      terminalCallbackResultKey: `ghtr_${'c'.repeat(64)}`,
      terminalCallbackAcceptedOperationId: 'd'.repeat(32),
      terminalCallbackId: `cb_terminal_${'e'.repeat(64)}`,
      terminalCallbackResultDigest: `sha256:${'f'.repeat(64)}`,
      terminalCallbackResultRevision: 1,
      terminalCallbackEffectGeneration: 1,
    });
    mockFind.mockReturnValueOnce(cursor([candidate]));
    mockGetConvo.mockResolvedValueOnce(null);
    mockUpdateOne.mockResolvedValueOnce({ acknowledged: true, matchedCount: 1, modifiedCount: 1 });

    await expect(redriveLegacyDeletedOriginMissionAdjudications()).resolves.toEqual({
      scanned: 1,
      redriven: 1,
      skipped: 0,
      failed: 0,
    });

    expect(
      require('@librechat/api').fenceGlassHiveTerminalCallbackAcceptedOperation,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        reference: expect.objectContaining({
          resultKey: candidate.terminalCallbackResultKey,
          resultRevision: 1,
          generation: 1,
        }),
      }),
    );

    expect(mockUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: evidenceId,
        ownerId: 'user-1',
        state: 'deadletter',
        attempts: 10,
        errorCode: 'mission_adjudication_retry_exhausted',
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          state: 'pending',
          attempts: 0,
          errorCode: '',
          legacyDeliveryParentRedriveVersion: 1,
          legacyDeliveryParentPriorAttempts: 10,
        }),
      }),
    );
  });

  test('does not redrive the same legacy shape while its origin conversation still exists', async () => {
    const evidenceId = 'ghe_11111111111111111111111111111111';
    const candidate = row({
      _id: evidenceId,
      evidenceId,
      state: 'deadletter',
      attempts: 10,
      errorCode: 'mission_adjudication_retry_exhausted',
      adjudicationGroupId: 'ghag_22222222222222222222222222222222',
      adjudicationGroupMemberIds: [evidenceId],
      terminalCallbackResultKey: `ghtr_${'3'.repeat(64)}`,
      terminalCallbackAcceptedOperationId: '4'.repeat(32),
      terminalCallbackId: `cb_terminal_${'5'.repeat(64)}`,
      terminalCallbackResultDigest: `sha256:${'6'.repeat(64)}`,
      terminalCallbackResultRevision: 1,
      terminalCallbackEffectGeneration: 1,
    });
    mockFind.mockReturnValueOnce(cursor([candidate]));

    await expect(redriveLegacyDeletedOriginMissionAdjudications()).resolves.toEqual({
      scanned: 1,
      redriven: 0,
      skipped: 1,
      failed: 0,
    });

    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  test('classifies a generic synthesis failure by its durable recovery stage', async () => {
    mockFind.mockReturnValueOnce(cursor([row()]));
    mockPrepareCortexFollowUpMessage.mockRejectedValueOnce(new Error('synthetic private detail'));

    await expect(flushGlassHiveMissionAdjudications({ ownerId: 'user-1' })).resolves.toEqual(
      expect.objectContaining({ failed: 1 }),
    );
    expect(mockUpdateOne).toHaveBeenCalledWith(
      { _id: 'cb-1', state: 'processing' },
      expect.objectContaining({
        $set: expect.objectContaining({
          state: 'failed',
          errorCode: 'mission_adjudication_prepare_synthesis_failed',
        }),
      }),
    );
  });

  test('dead-letters a permanently failing adjudication after the bounded retry budget', async () => {
    const exhausted = row({ attempts: 9 });
    mockFind.mockReturnValueOnce(cursor([exhausted]));
    mockFindOneAndUpdate.mockResolvedValueOnce({
      ...exhausted,
      state: 'processing',
      attempts: 10,
    });
    mockCreateCortexFollowUpMessage.mockRejectedValueOnce(new Error('synthetic persistent outage'));

    await expect(flushGlassHiveMissionAdjudications({ ownerId: 'user-1' })).resolves.toEqual(
      expect.objectContaining({ failed: 1 }),
    );
    const terminalUpdate = mockUpdateOne.mock.calls.find(
      ([filter, update]) => filter.state === 'processing' && update?.$set?.state === 'deadletter',
    );
    expect(terminalUpdate).toBeDefined();
    expect(terminalUpdate[1].$set).toMatchObject({
      state: 'deadletter',
      errorCode: 'mission_adjudication_retry_exhausted',
    });
    expect(terminalUpdate[1].$set).not.toHaveProperty('nextAttemptAt');
  });

  test('retries surface delivery from the persisted Main-authored message without regenerating it', async () => {
    mockFind.mockReturnValueOnce(cursor([row()]));
    mockEnqueueDelivery.mockRejectedValueOnce(
      Object.assign(new Error('synthetic delivery outage'), { code: 'delivery_unavailable' }),
    );

    await expect(flushGlassHiveMissionAdjudications({ ownerId: 'user-1' })).resolves.toEqual(
      expect.objectContaining({ failed: 1 }),
    );
    expect(mockCreateCortexFollowUpMessage).toHaveBeenCalledTimes(1);
    expect(mockUpdateOne).toHaveBeenCalledWith(
      { _id: 'cb-1', state: 'processing' },
      expect.objectContaining({
        $set: expect.objectContaining({
          state: 'delivery_pending',
          followUpMessageId: 'follow-up-1',
        }),
      }),
    );

    const retry = row({
      state: 'pending',
      followUpMessageId: 'follow-up-1',
      followUpText: 'Main-authored synthetic follow-up.',
    });
    retainAuthoredFollowUp(retry);
    mockFind.mockReturnValueOnce(cursor([retry]));
    mockFindOneAndUpdate.mockResolvedValueOnce({ ...retry, state: 'processing' });
    mockEnqueueDelivery.mockResolvedValueOnce({ configured: 1, enqueued: 1 });

    await expect(flushGlassHiveMissionAdjudications({ ownerId: 'user-1' })).resolves.toEqual(
      expect.objectContaining({ visible: 1, failed: 0 }),
    );
    expect(mockCreateCortexFollowUpMessage).toHaveBeenCalledTimes(1);
    expect(mockEnqueueDelivery).toHaveBeenLastCalledWith(
      expect.objectContaining({
        message: {
          messageId: 'follow-up-1',
          text: 'Main-authored synthetic follow-up.',
          user: retry.ownerId,
          conversationId: retry.accountContinuationConversationId || retry.conversationId,
          isCreatedByUser: false,
        },
      }),
    );
  });

  test('keeps a zero-target Main continuation durably unresolved and retryable', async () => {
    mockFind.mockReturnValueOnce(cursor([row()]));
    mockCreateCortexFollowUpMessage.mockResolvedValueOnce({
      messageId: 'follow-up-unresolved',
      text: 'Main-authored result.',
    });
    mockEnqueueDelivery.mockResolvedValueOnce({ configured: 1, enqueued: 0, deliveries: [] });

    await expect(flushGlassHiveMissionAdjudications({ ownerId: 'user-1' })).resolves.toEqual(
      expect.objectContaining({ failed: 1, visible: 0 }),
    );
    expect(mockRecordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'failed',
        followUpMessageId: 'follow-up-unresolved',
        errorCode: 'mission_surface_delivery_unresolved',
      }),
    );
    expect(mockUpdateOne).toHaveBeenCalledWith(
      { _id: 'cb-1', state: 'processing' },
      expect.objectContaining({
        $set: expect.objectContaining({
          state: 'delivery_pending',
          errorCode: 'mission_surface_delivery_unresolved',
        }),
      }),
    );
  });

  describe('committed linked Web projection', () => {
    function completedPresentation(overrides = {}) {
      return row({
        state: 'completed',
        surface: 'web',
        destinations: [{ surface: 'librechat' }],
        followUpMessageId: 'retained-main-result',
        followUpText: 'Retained Main-authored result.',
        authoredAt: new Date('2026-08-28T05:02:26.000Z'),
        webPresentationMessageId: 'retained-main-result',
        webPresentedAt: new Date('2026-08-28T05:02:27.000Z'),
        ...overrides,
      });
    }

    function recoverOnly(completed) {
      mockFind.mockImplementation((filter) =>
        cursor(filter.state === 'completed' ? [completed] : []),
      );
    }

    const projectionWrites = () =>
      mockUpdateOne.mock.calls.filter(([, update]) => update?.$set?.webProjectionReconciledAt);

    test.each([
      { surface: 'web', destinations: [{ surface: 'librechat' }] },
      { surface: 'voice', destinations: [{ surface: 'voice', voiceCallSessionId: 'ended-call' }] },
    ])(
      'projects committed $surface presentation through the existing local destination',
      async (input) => {
        const pending = row(input);
        mockFind.mockReturnValueOnce(cursor([pending]));
        mockFindOneAndUpdate.mockResolvedValueOnce({ ...pending, state: 'processing' });
        mockEnqueueDelivery.mockResolvedValueOnce({
          configured: 0,
          enqueued: 0,
          linkedWebCommitted: true,
        });

        await expect(
          flushGlassHiveMissionAdjudications({ ownerId: 'user-1' }),
        ).resolves.toMatchObject({ visible: 1, failed: 0 });

        expect(mockEnqueueDelivery).toHaveBeenCalledWith(
          expect.objectContaining({
            message: { messageId: 'follow-up-1', text: 'Main-authored synthetic follow-up.' },
            deliveryContext: expect.objectContaining({ destinations: [{ surface: 'librechat' }] }),
          }),
        );
        expect(projectionWrites()).toHaveLength(1);
        expect(projectionWrites()[0][0]).toEqual({
          _id: pending._id,
          ownerId: pending.ownerId,
          webPresentationMessageId: 'follow-up-1',
        });
        expect(mockRecordTraceDelivery).toHaveBeenCalledWith(
          expect.objectContaining({ surface: 'web', status: 'sent' }),
        );
      },
    );

    test('does not add a local destination to an ordinary pending Telegram result', async () => {
      const pending = row();
      mockFind.mockReturnValueOnce(cursor([pending]));
      await expect(
        flushGlassHiveMissionAdjudications({ ownerId: 'user-1' }),
      ).resolves.toMatchObject({ visible: 1, failed: 0 });
      expect(mockEnqueueDelivery.mock.calls[0][0].deliveryContext.destinations).toEqual(
        pending.destinations,
      );
      expect(projectionWrites()).toHaveLength(0);
      expect(mockRecordTraceDelivery).not.toHaveBeenCalled();
    });

    test('recovers a bounded completed local projection without authoring or resetting the result', async () => {
      const completed = completedPresentation();
      retainAuthoredFollowUp(completed);
      recoverOnly(completed);
      mockEnqueueDelivery.mockResolvedValueOnce({
        configured: 0,
        enqueued: 0,
        linkedWebCommitted: true,
      });

      await expect(reconcilePendingGlassHiveMissionAdjudications({ limit: 7 })).resolves.toEqual({
        rows: 0,
        owners: 0,
      });

      expect(mockFind.mock.calls[0][0]).toMatchObject({
        state: 'completed',
        webPresentedAt: { $type: 'date' },
        webPresentationMessageId: { $type: 'string', $ne: '' },
        webProjectionReconciledAt: { $exists: false },
      });
      expect(mockFind.mock.results[0].value.limit).toHaveBeenCalledWith(7);
      expect(mockEnqueueDelivery).toHaveBeenCalledWith(
        expect.objectContaining({
          message: {
            messageId: completed.followUpMessageId,
            text: completed.followUpText,
            user: completed.ownerId,
            conversationId: completed.accountContinuationConversationId || completed.conversationId,
            isCreatedByUser: false,
          },
        }),
      );
      expect(mockPrepareCortexFollowUpMessage).not.toHaveBeenCalled();
      expect(mockPersistPreparedCortexFollowUpMessage).not.toHaveBeenCalled();
      expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
      expect(mockRecordOutcome).not.toHaveBeenCalled();
      expect(mockUpdateOne.mock.calls.every(([, update]) => !update?.$set?.state)).toBe(true);
      expect(projectionWrites()).toHaveLength(1);
    });

    test.each(['missing', 'foreign owner', 'changed body'])(
      'rejects a retained projection with %s Message storage',
      async (invalid) => {
        const completed = completedPresentation();
        if (invalid !== 'missing') {
          retainAuthoredFollowUp(completed);
          if (invalid === 'foreign owner') mockStoredMessages[0].user = 'other-owner';
          else mockStoredMessages[0].text = 'Different authored result.';
        }
        recoverOnly(completed);
        await reconcilePendingGlassHiveMissionAdjudications();
        expect(mockMessageFindOne).toHaveBeenCalledWith(
          {
            user: 'user-1',
            conversationId: 'conversation-1',
            messageId: completed.followUpMessageId,
            isCreatedByUser: false,
          },
          undefined,
        );
        expect(mockEnqueueDelivery).not.toHaveBeenCalled();
        expect(mockPrepareCortexFollowUpMessage).not.toHaveBeenCalled();
        expect(projectionWrites()).toHaveLength(0);
        expect(mockUpdateOne).toHaveBeenCalledWith(
          { _id: completed._id, ownerId: completed.ownerId, state: 'completed' },
          { $set: { webProjectionNextAttemptAt: expect.any(Date) } },
        );
        expect(mockFind.mock.calls[0][0].$or).toEqual([
          { webProjectionNextAttemptAt: null },
          { webProjectionNextAttemptAt: { $lte: expect.any(Date) } },
        ]);
        expect(require('@librechat/data-schemas').logger.warn).toHaveBeenCalledWith(
          expect.any(String),
          { code: 'mission_authored_message_unavailable' },
        );
      },
    );

    test('does not mark a local projection reconciled without the committed summary', async () => {
      const completed = completedPresentation();
      retainAuthoredFollowUp(completed);
      recoverOnly(completed);
      mockEnqueueDelivery.mockResolvedValueOnce({ configured: 0, enqueued: 0 });
      await reconcilePendingGlassHiveMissionAdjudications();
      expect(mockEnqueueDelivery).toHaveBeenCalledTimes(1);
      expect(projectionWrites()).toHaveLength(0);
      expect(mockUpdateOne).toHaveBeenCalledWith(
        { _id: completed._id, ownerId: completed.ownerId, state: 'completed' },
        { $set: { webProjectionNextAttemptAt: expect.any(Date) } },
      );
    });

    test.each([
      {
        name: 'durably queued',
        summary: { configured: 1, enqueued: 1, unresolved: 0 },
        reconciled: true,
      },
      {
        name: 'unresolved',
        summary: { configured: 1, enqueued: 0, unresolved: 1 },
        reconciled: false,
      },
    ])(
      'retains pending Telegram delivery and marks only $name enqueue proof',
      async ({ summary, reconciled }) => {
        const telegram = { surface: 'telegram', telegramChatId: 'chat-1' };
        const completed = completedPresentation({ destinations: [telegram] });
        retainAuthoredFollowUp(completed);
        recoverOnly(completed);
        mockEnqueueDelivery.mockResolvedValueOnce(summary);
        await reconcilePendingGlassHiveMissionAdjudications();
        expect(mockEnqueueDelivery.mock.calls[0][0].deliveryContext.destinations).toEqual([
          telegram,
          { surface: 'librechat' },
        ]);
        expect(completed.destinations).toEqual([telegram]);
        expect(mockPrepareCortexFollowUpMessage).not.toHaveBeenCalled();
        expect(mockRecordTraceDelivery).not.toHaveBeenCalled();
        expect(projectionWrites()).toHaveLength(reconciled ? 1 : 0);
        if (!reconciled) {
          expect(require('@librechat/data-schemas').logger.warn).toHaveBeenCalledWith(
            expect.any(String),
            { code: 'mission_surface_delivery_unresolved' },
          );
        }
      },
    );

    test('rolls back projection writes when the current accepted callback authority is superseded', async () => {
      const completed = completedPresentation({
        terminalCallbackResultKey: `ghtr_${'a'.repeat(64)}`,
        terminalCallbackAcceptedOperationId: 'b'.repeat(32),
        terminalCallbackId: `cb_terminal_${'c'.repeat(64)}`,
        terminalCallbackResultDigest: `sha256:${'d'.repeat(64)}`,
        terminalCallbackResultRevision: 2,
        terminalCallbackEffectGeneration: 3,
      });
      retainAuthoredFollowUp(completed);
      recoverOnly(completed);
      mockEnqueueDelivery.mockResolvedValueOnce({
        configured: 0,
        enqueued: 0,
        linkedWebCommitted: true,
      });
      const committed = [];
      let pending = [];
      mockUpdateOne.mockImplementation(async (filter, update) => {
        pending.push({ filter, update });
        return { acknowledged: true, matchedCount: 1 };
      });
      const session = { id: 'projection-fence-session' };
      mockRunTransaction = async (operation) => {
        mockTransactionSession = session;
        pending = [];
        try {
          const result = await operation(session);
          committed.push(...pending);
          return result;
        } finally {
          mockTransactionSession = null;
          pending = [];
        }
      };
      const fence = require('@librechat/api').fenceGlassHiveTerminalCallbackAcceptedOperation;
      fence.mockResolvedValueOnce(false);
      await reconcilePendingGlassHiveMissionAdjudications();
      expect(fence).toHaveBeenCalledWith(
        expect.objectContaining({
          session,
          reference: expect.objectContaining({
            acceptedOperationId: completed.terminalCallbackAcceptedOperationId,
            resultRevision: 2,
            generation: 3,
          }),
        }),
      );
      expect(committed).toEqual([]);
      expect(mockPrepareCortexFollowUpMessage).not.toHaveBeenCalled();
      expect(require('@librechat/data-schemas').logger.warn).toHaveBeenCalledWith(
        expect.any(String),
        { code: 'glasshive_mission_evidence_superseded' },
      );
    });
  });
});
