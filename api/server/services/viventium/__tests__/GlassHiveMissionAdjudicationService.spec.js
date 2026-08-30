/* === VIVENTIUM START ===
 * Feature: Main-authored GlassHive mission adjudication tests.
 * === VIVENTIUM END === */

let mockUpdateOne;
let mockFindOneAndUpdate;
let mockFindOne;
let mockFind;
let mockGetUserById;
let mockGetConvo;
let mockSaveConvo;
let mockGetAgent;
let mockGetAppConfig;
let mockCreateCortexFollowUpMessage;
let mockRecordOutcome;
let mockEnqueueDelivery;
let mockRecordTraceDelivery;
let mockGetActiveCallSessionForConversation;
let mockDeferAfterCommit;
let mockTransactionSession;

jest.mock('mongoose', () => {
  const actual = jest.requireActual('mongoose');
  return {
    ...actual,
    transactionAsyncLocalStorage: {
      getStore: () => (mockTransactionSession ? { session: mockTransactionSession } : null),
    },
    connection: {
      ...actual.connection,
      collection: () => ({
        updateOne: (...args) => mockUpdateOne(...args),
        findOneAndUpdate: (...args) => mockFindOneAndUpdate(...args),
        findOne: (...args) => mockFindOne(...args),
        find: (...args) => mockFind(...args),
      }),
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
  getConvo: (...args) => mockGetConvo(...args),
  saveConvo: (...args) => mockSaveConvo(...args),
}));

jest.mock('~/models/Agent', () => ({
  getAgent: (...args) => mockGetAgent(...args),
}));

jest.mock('~/db/models', () => ({
  GlassHiveTerminalCallbackResult: {},
}));

jest.mock('~/server/services/Config', () => ({
  getAppConfig: (...args) => mockGetAppConfig(...args),
}));

jest.mock('~/server/services/viventium/BackgroundCortexFollowUpService', () => ({
  createCortexFollowUpMessage: (...args) => mockCreateCortexFollowUpMessage(...args),
}));

jest.mock('../CallSessionService', () => ({
  getActiveCallSessionForConversation: (...args) =>
    mockGetActiveCallSessionForConversation(...args),
}));

jest.mock('../GlassHiveCallbackBindingService', () => ({
  recordGlassHiveAdjudicationOutcome: (...args) => mockRecordOutcome(...args),
  isGlassHiveWorkTerminalCallback: (body = {}) =>
    body.work_terminal === true &&
    ['completed', 'failed', 'cancelled'].includes(String(body.work_state || '').toLowerCase()),
}));

jest.mock('../GlassHiveCallbackDeliveryService', () => ({
  enqueueGlassHiveCallbackDelivery: (...args) => mockEnqueueDelivery(...args),
}));

jest.mock('../OrchestrationTraceLedgerService', () => ({
  recordOrchestrationTraceDelivery: (...args) => mockRecordTraceDelivery(...args),
}));

jest.mock('../GlassHiveTerminalCallbackTransaction', () => ({
  deferGlassHiveTerminalCallbackAfterCommit: (...args) => mockDeferAfterCommit(...args),
  runGlassHiveTerminalCallbackTransaction: (operation) => operation(null),
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

describe('GlassHiveMissionAdjudicationService', () => {
  beforeEach(() => {
    clearAdjudicationTimersForTests();
    mockUpdateOne = jest.fn().mockResolvedValue({ acknowledged: true });
    mockFindOneAndUpdate = jest.fn(async (filter) => ({
      ...row({ _id: filter._id }),
      state: 'processing',
    }));
    mockFindOne = jest.fn().mockResolvedValue(null);
    mockFind = jest.fn().mockReturnValue(cursor([]));
    mockGetUserById = jest.fn().mockResolvedValue({ id: 'user-1', role: 'USER' });
    mockGetConvo = jest
      .fn()
      .mockResolvedValue({ conversationId: 'conversation-1', user: 'user-1' });
    mockSaveConvo = jest.fn().mockImplementation(async (_req, conversation) => conversation);
    mockGetAgent = jest.fn().mockResolvedValue({ id: 'main-agent', provider: 'openAI' });
    mockGetAppConfig = jest.fn().mockResolvedValue({ endpoints: { agents: {} } });
    mockCreateCortexFollowUpMessage = jest.fn().mockResolvedValue({ messageId: 'follow-up-1' });
    mockRecordOutcome = jest.fn().mockResolvedValue({});
    mockEnqueueDelivery = jest.fn().mockResolvedValue({ configured: 1, enqueued: 1 });
    mockRecordTraceDelivery = jest.fn().mockResolvedValue(null);
    mockGetActiveCallSessionForConversation = jest.fn().mockResolvedValue(null);
    mockDeferAfterCommit = jest.fn().mockReturnValue(false);
    mockTransactionSession = null;
  });

  afterEach(() => {
    clearAdjudicationTimersForTests();
    jest.useRealTimers();
  });

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

  test('defers account adjudication until callback commit and schedules nothing after abort', async () => {
    jest.useFakeTimers();
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
    expect(jest.getTimerCount()).toBe(0);

    await afterCommit[0]();
    await jest.advanceTimersByTimeAsync(COALESCE_MS);

    expect(mockFind).toHaveBeenCalledTimes(1);

    await enqueue('aborted-owner');
    expect(mockUpdateOne).toHaveBeenCalledTimes(2);
    expect(afterCommit).toHaveLength(2);
    expect(jest.getTimerCount()).toBe(0);

    await jest.runOnlyPendingTimersAsync();
    expect(mockFind).toHaveBeenCalledTimes(1);
  });

  test('serializes one owner flush and schedules one lossless follow-up flush', async () => {
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
    expect(jest.getTimerCount()).toBe(1);
    await jest.advanceTimersByTimeAsync(COALESCE_MS);
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
    const rows = [
      row(),
      row({
        _id: 'cb-2',
        evidenceId: 'cb-2',
        callbackRef: canonicalCallbackRef('cb-2'),
        originRef: 'ghi-origin-2',
        anchorMessageId: 'assistant-anchor-newer',
        evidence: 'Second result.',
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
        insightsData: expect.objectContaining({
          insights: [
            {
              cortexName: 'Mission evidence',
              insight: 'Verified synthetic result.',
              maxPromptChars: 12_000,
              authority: {
                kind: 'durable_terminal_callback',
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

  test('binds one coalesced Voice presentation to every exact Worker and the current call', async () => {
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
        surface: 'voice',
        destinations: [{ surface: 'voice', voiceCallSessionId: 'ended-origin-call' }],
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
    mockGetActiveCallSessionForConversation.mockResolvedValueOnce({
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

    expect(mockGetActiveCallSessionForConversation).toHaveBeenCalledWith({
      userId: 'user-1',
      conversationId: 'conversation-1',
    });
    expect(mockEnqueueDelivery).toHaveBeenCalledTimes(1);
    const input = mockEnqueueDelivery.mock.calls[0][0];
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
    expect(input.body.work_ref).toBe('work-a');
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

  test('uses a new account continuation when the origin conversation was deleted', async () => {
    mockFind.mockReturnValueOnce(cursor([row()]));
    mockGetConvo.mockResolvedValueOnce(null);
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
    mockCreateCortexFollowUpMessage.mockRejectedValueOnce(new Error('synthetic private detail'));

    await expect(flushGlassHiveMissionAdjudications({ ownerId: 'user-1' })).resolves.toEqual(
      expect.objectContaining({ failed: 1 }),
    );
    expect(mockUpdateOne).toHaveBeenCalledWith(
      { _id: 'cb-1', state: 'processing' },
      expect.objectContaining({
        $set: expect.objectContaining({
          state: 'failed',
          errorCode: 'mission_adjudication_synthesize_failed',
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
});
