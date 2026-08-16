/* === VIVENTIUM START ===
 * Feature: Main-authored GlassHive mission adjudication tests.
 * === VIVENTIUM END === */

let mockUpdateOne;
let mockFindOneAndUpdate;
let mockFind;
let mockGetUserById;
let mockGetConvo;
let mockSaveConvo;
let mockGetAgent;
let mockGetAppConfig;
let mockCreateCortexFollowUpMessage;
let mockRecordOutcome;
let mockEnqueueDelivery;

jest.mock('mongoose', () => ({
  connection: {
    collection: () => ({
      updateOne: (...args) => mockUpdateOne(...args),
      findOneAndUpdate: (...args) => mockFindOneAndUpdate(...args),
      find: (...args) => mockFind(...args),
    }),
  },
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('~/models', () => ({
  getUserById: (...args) => mockGetUserById(...args),
  getConvo: (...args) => mockGetConvo(...args),
  saveConvo: (...args) => mockSaveConvo(...args),
}));

jest.mock('~/models/Agent', () => ({
  getAgent: (...args) => mockGetAgent(...args),
}));

jest.mock('~/server/services/Config', () => ({
  getAppConfig: (...args) => mockGetAppConfig(...args),
}));

jest.mock('~/server/services/viventium/BackgroundCortexFollowUpService', () => ({
  createCortexFollowUpMessage: (...args) => mockCreateCortexFollowUpMessage(...args),
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

const {
  clearAdjudicationTimersForTests,
  enqueueGlassHiveMissionAdjudication,
  flushGlassHiveMissionAdjudications,
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

function row(overrides = {}) {
  return {
    _id: 'cb-1',
    evidenceId: 'cb-1',
    originRef: 'ghi-origin-1',
    workRef: 'gh-work-1',
    workerId: 'worker-1',
    runId: 'run-1',
    event: 'run.completed',
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
    mockFindOneAndUpdate = jest.fn(async (filter) => ({ ...row({ _id: filter._id }), state: 'processing' }));
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
  });

  afterAll(() => clearAdjudicationTimersForTests());

  test('persists exact terminal evidence idempotently before scheduling synthesis', async () => {
    await enqueueGlassHiveMissionAdjudication({
      binding: {
        originRef: 'ghi-origin-1',
        workRef: 'gh-work-1',
        ownerId: 'user-1',
        conversationId: 'conversation-1',
        anchorMessageId: 'assistant-anchor',
        mainAgentId: 'main-agent',
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
          state: 'pending',
        }),
      },
      { upsert: true },
    );
    expect(mockCreateCortexFollowUpMessage).not.toHaveBeenCalled();
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
            },
            { cortexName: 'Mission evidence', insight: 'Second result.', maxPromptChars: 12_000 },
          ],
        }),
        forceVisibleFollowUp: false,
        allowMovedOnUsefulFollowUp: true,
      }),
    );
    expect(mockRecordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'completed', followUpMessageId: 'follow-up-1' }),
    );
    expect(mockEnqueueDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ event: 'main.followup' }),
        message: expect.objectContaining({ messageId: 'follow-up-1' }),
        deliveryContext: expect.objectContaining({
          destinations: [
            expect.objectContaining({ surface: 'telegram', telegramChatId: 'chat-1' }),
          ],
        }),
      }),
    );
  });

  test('keeps Main semantic NTA/redundancy silent despite the useful-only moved-on exemption', async () => {
    mockFind.mockReturnValueOnce(cursor([row()]));
    mockCreateCortexFollowUpMessage.mockResolvedValueOnce(null);

    await expect(flushGlassHiveMissionAdjudications({ ownerId: 'user-1' })).resolves.toEqual(
      expect.objectContaining({ silent: 1, visible: 0 }),
    );
    expect(mockRecordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ originRef: 'ghi-origin-1', state: 'silent' }),
    );
    expect(mockCreateCortexFollowUpMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        forceVisibleFollowUp: false,
        allowMovedOnUsefulFollowUp: true,
      }),
    );
    expect(mockEnqueueDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        suppress: true,
        body: expect.objectContaining({
          event: 'main.followup',
          origin_ref: 'ghi-origin-1',
          work_ref: 'gh-work-1',
        }),
        deliveryContext: expect.objectContaining({
          destinations: [
            expect.objectContaining({ surface: 'telegram', telegramChatId: 'chat-1' }),
          ],
        }),
      }),
    );
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
        forceVisibleFollowUp: false,
        allowMovedOnUsefulFollowUp: true,
      }),
    );
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

  test('does not create an empty account continuation when Main judges deleted-origin evidence redundant', async () => {
    mockFind.mockReturnValueOnce(cursor([row()]));
    mockGetConvo.mockResolvedValueOnce(null);
    mockCreateCortexFollowUpMessage.mockResolvedValueOnce(null);

    await expect(flushGlassHiveMissionAdjudications({ ownerId: 'user-1' })).resolves.toEqual(
      expect.objectContaining({ silent: 1, failed: 0 }),
    );

    expect(mockSaveConvo).not.toHaveBeenCalled();
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

    mockFind.mockReturnValueOnce(
      cursor([row({ state: 'failed', nextAttemptAt: new Date(0) })]),
    );
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
