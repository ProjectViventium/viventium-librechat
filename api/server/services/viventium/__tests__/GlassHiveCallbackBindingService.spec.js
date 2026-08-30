/* === VIVENTIUM START ===
 * Feature: Authoritative GlassHive callback origin/delivery bindings.
 * Purpose: Prove callback targets and scheduled external-work truth come from Core-owned state,
 * never callback-supplied Telegram identifiers.
 * === VIVENTIUM END === */

let mockBindingFindOne;
let mockBindingUpdateOne;
let mockExternalFind;
let mockExternalCursor;
let mockExternalFindOne;
let mockExternalFindOneAndUpdate;
let mockExternalUpdateOne;
let mockResolveTelegramMappingByUserId;
let mockRequestAccountApi;
let mockMarkUserParallelWorkKnown;
let mockGetMessageAncestorBranch;
let mockGetMessages;
let mockRecordTraceLaunch;
let mockRecordTraceAcceptedLaunch;
let mockRecordTraceFailedLaunch;
let mockRecordTraceCallback;
let mockRecordGlassHiveWorkDetailTrace;

jest.mock('~/models', () => ({
  getMessageAncestorBranch: (...args) => mockGetMessageAncestorBranch(...args),
  getMessages: (...args) => mockGetMessages(...args),
  markUserParallelWorkKnown: (...args) => mockMarkUserParallelWorkKnown(...args),
}));

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('@librechat/api', () => {
  const crypto = require('crypto');
  return {
    ...jest.requireActual('@librechat/api'),
    canonicalizeGlassHiveCallbackRef: (value) =>
      /^callback_sha256:[a-f0-9]{64}$/.test(String(value || '').trim())
        ? String(value).trim()
        : `callback_sha256:${crypto.createHash('sha256').update(String(value).trim()).digest('hex')}`,
  };
});

jest.mock('mongoose', () => {
  const actual = jest.requireActual('mongoose');
  return {
    ...actual,
    connection: {
      ...actual.connection,
      collection: (name) => {
        if (name === 'viventium_glasshive_callback_bindings') {
          return {
            findOne: (...args) => mockBindingFindOne(...args),
            updateOne: (...args) => mockBindingUpdateOne(...args),
          };
        }
        if (name === 'viventium_external_work') {
          return {
            find: (...args) => mockExternalFind(...args),
            findOne: (...args) => mockExternalFindOne(...args),
            findOneAndUpdate: (...args) => mockExternalFindOneAndUpdate(...args),
            updateOne: (...args) => mockExternalUpdateOne(...args),
          };
        }
        throw new Error(`Unexpected collection ${name}`);
      },
    },
  };
});

jest.mock('~/server/services/TelegramLinkService', () => ({
  resolveTelegramMappingByUserId: (...args) => mockResolveTelegramMappingByUserId(...args),
}));

jest.mock('../OrchestrationTraceLedgerService', () => ({
  recordOrchestrationTraceLaunch: (...args) => mockRecordTraceLaunch(...args),
  recordOrchestrationTraceAcceptedLaunch: (...args) => mockRecordTraceAcceptedLaunch(...args),
  recordOrchestrationTraceFailedLaunch: (...args) => mockRecordTraceFailedLaunch(...args),
  recordOrchestrationTraceCallback: (...args) => mockRecordTraceCallback(...args),
  recordGlassHiveWorkDetailTrace: (...args) => mockRecordGlassHiveWorkDetailTrace(...args),
}));

jest.mock('../GlassHiveAccountService', () => {
  const nodeCrypto = require('crypto');
  return {
    buildTrustedDelegationIdentity: ({
      ownerId,
      sourceEventId,
      objectiveOrdinal,
      callIdentityDigest,
      goal,
    }) => {
      const goalDigest = nodeCrypto.createHash('sha256').update(String(goal)).digest('hex');
      return {
        goalDigest,
        idempotencyKey: nodeCrypto
          .createHash('sha256')
          .update(
            `${ownerId}\0${sourceEventId}\0${callIdentityDigest || objectiveOrdinal}\0${goalDigest}`,
          )
          .digest('hex'),
      };
    },
    requestAccountApi: (...args) => mockRequestAccountApi(...args),
    signTrustedDelegationIdentity: () => 'f'.repeat(64),
  };
});

const {
  attachGlassHiveLaunchOrigin,
  attachGlassHiveTrustedLaunchMetadata,
  confirmGlassHiveCallbackContext,
  getSchedulerExternalWorkSummary,
  hasAcceptedGlassHiveLaunchForPresentation,
  hasKnownExternalWork,
  markGlassHiveLaunchDispatchUnknown,
  markGlassHiveLaunchDispatchReady,
  markGlassHiveLaunchPreDispatchFailed,
  reconcileKnownExternalWorkHints,
  reconcileUnknownGlassHiveLaunches,
  reconcileGlassHiveLaunchResult,
  recordGlassHiveAdjudicationOutcome,
  recordGlassHiveCallbackExternalState,
  recordGlassHiveSurfaceDeliveryOutcome,
  registerGlassHiveLaunchContext,
  resolveTrustedGlassHiveCallIdentity,
  resolveGlassHiveCallbackContext,
} = require('../GlassHiveCallbackBindingService');

function canonicalCallbackRef(value) {
  const crypto = require('crypto');
  return `callback_sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

describe('GlassHiveCallbackBindingService', () => {
  beforeEach(() => {
    mockBindingFindOne = jest.fn();
    mockBindingUpdateOne = jest.fn().mockResolvedValue({ acknowledged: true });
    mockExternalCursor = {
      sort: jest.fn(() => mockExternalCursor),
      limit: jest.fn(() => mockExternalCursor),
      toArray: jest.fn().mockResolvedValue([]),
    };
    mockExternalFind = jest.fn().mockReturnValue(mockExternalCursor);
    mockExternalFindOne = jest.fn();
    mockExternalFindOneAndUpdate = jest.fn();
    mockExternalUpdateOne = jest.fn().mockResolvedValue({ acknowledged: true });
    mockResolveTelegramMappingByUserId = jest.fn().mockResolvedValue({
      telegramUserId: 'telegram-authoritative',
    });
    mockRequestAccountApi = jest.fn().mockResolvedValue({
      valid: true,
      originRef: 'ghi-origin-1',
      workRef: 'gh-work-1',
    });
    mockMarkUserParallelWorkKnown = jest.fn().mockResolvedValue(true);
    mockGetMessageAncestorBranch = jest.fn().mockResolvedValue([]);
    mockGetMessages = jest.fn().mockResolvedValue([]);
    mockRecordTraceLaunch = jest.fn().mockResolvedValue([]);
    mockRecordTraceAcceptedLaunch = jest.fn().mockResolvedValue(null);
    mockRecordTraceFailedLaunch = jest.fn().mockResolvedValue(null);
    mockRecordTraceCallback = jest.fn().mockResolvedValue([]);
    mockRecordGlassHiveWorkDetailTrace = jest
      .fn()
      .mockResolvedValue({ accepted: true, errors: [], eventCount: 12 });
  });

  test('recognizes only an exact accepted launch as a durable mission receipt', async () => {
    mockBindingFindOne.mockResolvedValueOnce({ _id: 'ghi-accepted' });

    await expect(
      hasAcceptedGlassHiveLaunchForPresentation({
        ownerId: 'owner-1',
        conversationId: 'conversation-1',
        responseMessageId: 'assistant-1',
        sourceEventId: 'source-1',
      }),
    ).resolves.toBe(true);
    expect(mockBindingFindOne).toHaveBeenCalledWith(
      {
        ownerId: 'owner-1',
        conversationId: 'conversation-1',
        anchorMessageId: 'assistant-1',
        sourceEventId: 'source-1',
        launchState: { $in: ['accepted', 'callback_confirmed'] },
        workRef: { $nin: ['', null] },
      },
      { projection: { _id: 1 } },
    );

    mockBindingFindOne.mockResolvedValueOnce(null);
    await expect(
      hasAcceptedGlassHiveLaunchForPresentation({
        ownerId: 'owner-1',
        conversationId: 'conversation-1',
        responseMessageId: 'assistant-2',
        sourceEventId: 'source-2',
      }),
    ).resolves.toBe(false);
  });

  test('binds a selected historical rapid source to its own assistant anchor, never the authoring turn', async () => {
    mockGetMessages
      .mockResolvedValueOnce([
        {
          messageId: 'user-b',
          parentMessageId: 'assistant-a',
          isCreatedByUser: true,
        },
      ])
      .mockResolvedValueOnce([
        {
          messageId: 'assistant-b',
          parentMessageId: 'user-b',
          isCreatedByUser: false,
        },
      ]);

    await registerGlassHiveLaunchContext({
      user: { id: 'owner-rapid' },
      requestBody: {
        messageId: 'assistant-c',
        parentMessageId: 'user-c',
        conversationId: 'conversation-rapid',
        viventiumAuthoringSourceEventId: 'event-c',
        viventiumSourceEventId: 'event-b',
        viventiumTriggeringSourceSegments: [
          { ordinal: 0, source_event_id: 'event-b', source_index: 0, text: 'Mission B' },
        ],
      },
      toolName: 'workspace_launch',
      toolArguments: { description: 'Run Mission B.' },
      toolCall: { id: 'call-b' },
    });

    expect(mockGetMessages).toHaveBeenNthCalledWith(
      1,
      {
        user: 'owner-rapid',
        conversationId: 'conversation-rapid',
        isCreatedByUser: true,
        'metadata.viventium.interactionContext.source_event_id': 'event-b',
      },
      'messageId parentMessageId isCreatedByUser createdAt',
    );
    expect(mockRecordTraceLaunch).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: 'owner-rapid',
        sourceEventRef: 'event-b',
        promptLayers: expect.any(Object),
      }),
    );
    expect(mockGetMessages).toHaveBeenNthCalledWith(
      2,
      {
        user: 'owner-rapid',
        conversationId: 'conversation-rapid',
        isCreatedByUser: false,
        parentMessageId: 'user-b',
      },
      'messageId parentMessageId isCreatedByUser createdAt',
    );
    expect(mockBindingUpdateOne.mock.calls[0][1].$setOnInsert).toEqual(
      expect.objectContaining({
        anchorMessageId: 'assistant-b',
        requestedParentMessageId: 'user-b',
        sourceEventId: 'event-b',
      }),
    );
    expect(mockExternalUpdateOne.mock.calls[0][1].$setOnInsert).toEqual(
      expect.objectContaining({
        anchorMessageId: 'assistant-b',
        requestedParentMessageId: 'user-b',
        sourceEventId: 'event-b',
      }),
    );
    expect(mockGetMessageAncestorBranch).not.toHaveBeenCalled();
    expect(JSON.stringify(mockBindingUpdateOne.mock.calls)).not.toContain('assistant-c');
    expect(JSON.stringify(mockBindingUpdateOne.mock.calls)).not.toContain('user-c');
  });

  test('binds an uncommitted rapid source to the exact current revision anchor', async () => {
    mockGetMessages
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          messageId: 'user-c',
          parentMessageId: 'assistant-a',
          isCreatedByUser: true,
        },
      ])
      .mockResolvedValueOnce([
        {
          messageId: 'assistant-c',
          parentMessageId: 'user-c',
          isCreatedByUser: false,
        },
      ]);

    await registerGlassHiveLaunchContext({
      user: { id: 'owner-rapid' },
      requestBody: {
        messageId: 'assistant-c',
        parentMessageId: 'user-c',
        conversationId: 'conversation-rapid',
        viventiumAuthoringSourceEventId: 'event-c',
        viventiumSourceEventId: 'event-b',
        viventiumTriggeringSourceSegments: [
          { ordinal: 0, source_event_id: 'event-b', source_index: 0, text: 'Mission B' },
        ],
      },
      toolName: 'workspace_launch',
      toolArguments: { description: 'Run Mission B.' },
      toolCall: { id: 'call-b' },
    });

    expect(mockGetMessages).toHaveBeenNthCalledWith(
      2,
      {
        user: 'owner-rapid',
        conversationId: 'conversation-rapid',
        messageId: 'user-c',
        isCreatedByUser: true,
        'metadata.viventium.interactionContext.source_event_id': 'event-c',
      },
      'messageId parentMessageId isCreatedByUser createdAt',
    );
    expect(mockGetMessages).toHaveBeenNthCalledWith(
      3,
      {
        user: 'owner-rapid',
        conversationId: 'conversation-rapid',
        messageId: 'assistant-c',
        parentMessageId: 'user-c',
        isCreatedByUser: false,
      },
      'messageId parentMessageId isCreatedByUser createdAt',
    );
    expect(mockBindingUpdateOne.mock.calls[0][1].$setOnInsert).toEqual(
      expect.objectContaining({
        anchorMessageId: 'assistant-c',
        requestedParentMessageId: 'user-c',
        sourceEventId: 'event-b',
      }),
    );
  });

  test('fails closed when a selected historical rapid source has no exact message anchor', async () => {
    mockGetMessages.mockResolvedValue([]);

    await expect(
      registerGlassHiveLaunchContext({
        user: { id: 'owner-rapid' },
        requestBody: {
          messageId: 'assistant-c',
          parentMessageId: 'user-c',
          conversationId: 'conversation-rapid',
          viventiumAuthoringSourceEventId: 'event-c',
          viventiumSourceEventId: 'event-b',
          viventiumTriggeringSourceSegments: [
            { ordinal: 0, source_event_id: 'event-b', source_index: 0, text: 'Mission B' },
          ],
        },
        toolName: 'workspace_launch',
        toolArguments: { description: 'Run Mission B.' },
        toolCall: { id: 'call-b' },
      }),
    ).rejects.toMatchObject({ code: 'glasshive_selected_source_anchor_unavailable' });

    expect(mockBindingUpdateOne).not.toHaveBeenCalled();
    expect(mockExternalUpdateOne).not.toHaveBeenCalled();
  });

  test('persists a Core-owned target binding and required schedule relation before launch', async () => {
    const launch = await registerGlassHiveLaunchContext({
      user: { id: 'user-1' },
      toolName: 'workspace_launch',
      toolArguments: {
        goal: 'Prepare the synthetic report',
        require_callback: true,
        bootstrap_bundle_json: { env: { SECRET: 'must-not-enter-identity' } },
      },
      requestBody: {
        messageId: 'assistant-anchor',
        parentMessageId: 'user-message',
        conversationId: 'conversation-1',
        viventiumSourceEventId: 'scheduler:occurrence-1',
        viventiumTriggeringSourceSegments: [
          { ordinal: 0, text: 'Prepare the synthetic report exactly.' },
        ],
        viventiumSurface: 'workbench',
        viventiumSchedulerDispatchDocumentId: 'dispatch-doc-1',
        viventiumSchedulerOccurrenceKey: 'schedule:occurrence-1',
        viventiumScheduleId: 'schedule-1',
        viventiumSchedulerDeliveryChannels: ['telegram', 'librechat'],
        viventiumSchedulerExternalWorkRequired: true,
        viventiumGlassHiveIdempotencyKey: 'main:assistant-anchor',
      },
      toolCall: { id: 'call-launch-1', stepId: 'step-launch-1', turn: 0 },
    });

    expect(mockBindingUpdateOne).toHaveBeenCalledTimes(1);
    const [bindingFilter, bindingUpdate] = mockBindingUpdateOne.mock.calls[0];
    expect(launch).toEqual(
      expect.objectContaining({
        bindingId: expect.stringMatching(/^ghi_/),
        originRef: expect.stringMatching(/^ghi_/),
        sourceEventId: 'scheduler:occurrence-1',
        objectiveOrdinal: 0,
        delegationIdentity: expect.objectContaining({
          version: 1,
          idempotency_key: expect.stringMatching(/^[a-f0-9]{64}$/),
          goal_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
          source_event_id: 'scheduler:occurrence-1',
          objective_ordinal: 0,
          call_identity_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      }),
    );
    expect(bindingFilter).toEqual({ _id: launch.originRef });
    expect(bindingUpdate.$setOnInsert).toEqual(
      expect.objectContaining({
        ownerId: 'user-1',
        conversationId: 'conversation-1',
        anchorMessageId: 'assistant-anchor',
        requestedParentMessageId: 'user-message',
        configuredDestinations: [{ surface: 'telegram' }, { surface: 'librechat' }],
        scheduleOccurrenceKey: 'schedule:occurrence-1',
        launchState: 'prepared',
        preparationExpiresAt: expect.any(Date),
        workRef: '',
        sourceEventId: 'scheduler:occurrence-1',
        objectiveOrdinal: 0,
        objectiveDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
    expect(bindingUpdate.$set).toEqual({ updatedAt: expect.any(Date) });
    expect(JSON.stringify(bindingUpdate)).not.toContain('must-not-enter-identity');

    expect(mockExternalUpdateOne).toHaveBeenCalledTimes(1);
    expect(mockMarkUserParallelWorkKnown).not.toHaveBeenCalled();
    expect(mockExternalUpdateOne.mock.calls[0][1].$setOnInsert).toEqual(
      expect.objectContaining({
        ownerId: 'user-1',
        required: true,
        schedulerDispatchDocumentId: 'dispatch-doc-1',
        scheduleOccurrenceKey: 'schedule:occurrence-1',
        externalState: 'preparing',
        launchState: 'prepared',
        preparationExpiresAt: expect.any(Date),
        originRef: launch.originRef,
        workRef: '',
        sourceEventId: 'scheduler:occurrence-1',
        objectiveOrdinal: 0,
        objectiveDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
  });

  test('does not let model-authored callback flags make interactive work scheduler-required', async () => {
    await registerGlassHiveLaunchContext({
      user: { id: 'user-1' },
      toolName: 'workspace_launch',
      toolArguments: {
        goal: 'Prepare an informational synthetic report',
        require_callback: true,
      },
      requestBody: {
        messageId: 'assistant-informational',
        parentMessageId: 'user-message',
        conversationId: 'conversation-1',
        viventiumSourceEventId: 'interactive:event-1',
      },
      toolCall: { id: 'call-informational', stepId: 'step-informational', turn: 0 },
    });

    expect(mockExternalUpdateOne.mock.calls[0][1].$setOnInsert.required).toBe(false);
  });

  test('re-seeds known-work hints for distinct owners without ever clearing them locally', async () => {
    mockExternalCursor.toArray.mockResolvedValue([
      { ownerId: 'owner-a' },
      { ownerId: 'owner-a' },
      { ownerId: 'owner-b' },
      { ownerId: '' },
    ]);
    mockMarkUserParallelWorkKnown.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await expect(reconcileKnownExternalWorkHints({ limit: 10 })).resolves.toEqual({
      scanned: 4,
      updatedOwners: 1,
      failedOwners: 1,
    });

    expect(mockExternalFind).toHaveBeenCalledWith(
      expect.objectContaining({
        $or: expect.arrayContaining([
          {
            launchState: 'not_dispatched',
            externalState: 'failed',
            attentionPending: { $ne: false },
          },
          expect.objectContaining({
            launchState: { $nin: ['prepared', 'not_dispatched'] },
            $or: expect.arrayContaining([
              { attentionPending: true },
              {
                deliveryState: {
                  $in: ['pending', 'enqueued', 'failed', 'unresolved', 'unknown'],
                },
              },
            ]),
          }),
        ]),
      }),
      {
        projection: expect.objectContaining({
          ownerId: 1,
          workRef: 1,
          runId: 1,
          externalState: 1,
          stateReconciliationNextAt: 1,
        }),
      },
    );
    expect(mockMarkUserParallelWorkKnown.mock.calls).toEqual([['owner-a'], ['owner-b']]);
  });

  test('reconciles stale running work from its owner-scoped, trace-validated terminal detail', async () => {
    const row = {
      _id: 'origin-reconcile',
      originRef: 'origin-reconcile',
      ownerId: 'owner-reconcile',
      workRef: 'work-reconcile',
      runId: 'run-reconcile',
      externalState: 'running',
      launchState: 'accepted',
      deliveryState: 'unknown',
      attentionPending: true,
    };
    const detail = {
      workRef: 'work-reconcile',
      runRef: `run_sha256:${'a'.repeat(64)}`,
      state: 'completed',
      lifecycle: { attemptNumber: 2, endedAt: '2026-08-25T12:00:00.000Z' },
    };
    mockExternalCursor.toArray.mockResolvedValueOnce([row]);
    mockRequestAccountApi.mockResolvedValueOnce(detail);

    await expect(reconcileKnownExternalWorkHints({ limit: 10 })).resolves.toEqual({
      scanned: 1,
      updatedOwners: 1,
      failedOwners: 0,
    });

    expect(mockRequestAccountApi).toHaveBeenCalledWith({
      ownerId: 'owner-reconcile',
      path: '/v1/work/work-reconcile',
      timeoutMs: 3000,
    });
    expect(mockRecordGlassHiveWorkDetailTrace).toHaveBeenCalledWith({
      ownerId: 'owner-reconcile',
      originRef: 'origin-reconcile',
      workRef: 'work-reconcile',
      runRef: 'run-reconcile',
      detail,
    });
    expect(mockExternalUpdateOne).toHaveBeenCalledWith(
      {
        ownerId: 'owner-reconcile',
        workRef: 'work-reconcile',
        externalState: { $nin: ['completed', 'failed', 'cancelled'] },
      },
      {
        $set: expect.objectContaining({
          externalState: 'completed',
          stateReconciliationRunRef: `run_sha256:${'a'.repeat(64)}`,
          stateReconciliationAttemptNumber: 2,
        }),
      },
    );
    expect(mockExternalUpdateOne.mock.calls[0][1].$set).not.toHaveProperty('deliveryState');
  });

  test('persists a bounded retry when authoritative terminal detail cannot be verified', async () => {
    mockExternalCursor.toArray.mockResolvedValueOnce([
      {
        _id: 'origin-retry',
        ownerId: 'owner-retry',
        workRef: 'work-retry',
        runId: 'run-retry',
        externalState: 'running',
        launchState: 'accepted',
      },
    ]);
    mockRequestAccountApi.mockRejectedValueOnce(
      Object.assign(new Error('temporary upstream outage'), { code: 'provider_unavailable' }),
    );

    await expect(reconcileKnownExternalWorkHints({ limit: 10 })).resolves.toEqual({
      scanned: 1,
      updatedOwners: 1,
      failedOwners: 0,
    });

    expect(mockRecordGlassHiveWorkDetailTrace).not.toHaveBeenCalled();
    expect(mockExternalUpdateOne).toHaveBeenCalledWith(
      {
        ownerId: 'owner-retry',
        workRef: 'work-retry',
        externalState: { $nin: ['completed', 'failed', 'cancelled'] },
      },
      {
        $set: expect.objectContaining({
          stateReconciliationPendingAt: expect.any(Date),
          stateReconciliationNextAt: expect.any(Date),
          stateReconciliationErrorCode: 'provider_unavailable',
        }),
        $inc: { stateReconciliationAttempts: 1 },
      },
    );
  });

  test('rejects cross-work producer detail and never propagates its untrusted trace context', async () => {
    mockExternalCursor.toArray.mockResolvedValueOnce([
      {
        _id: 'origin-safe-scope',
        ownerId: 'owner-safe-scope',
        workRef: 'work-safe-scope',
        runId: 'run-safe-scope',
        externalState: 'running',
        launchState: 'accepted',
      },
    ]);
    mockRequestAccountApi.mockResolvedValueOnce({
      workRef: 'work-another-scope',
      state: 'completed',
      traceparent: 'external-untrusted-trace',
      baggage: 'private=synthetic',
    });

    await reconcileKnownExternalWorkHints({ limit: 10 });

    expect(mockRecordGlassHiveWorkDetailTrace).not.toHaveBeenCalled();
    const persisted = mockExternalUpdateOne.mock.calls[0][1].$set;
    expect(persisted.stateReconciliationErrorCode).toBe(
      'work_state_reconciliation_identity_mismatch',
    );
    expect(persisted).not.toHaveProperty('traceparent');
    expect(persisted).not.toHaveProperty('baggage');
    expect(JSON.stringify(persisted)).not.toContain('work-another-scope');
  });

  test('respects a durable retry deadline before reading GlassHive work again', async () => {
    mockExternalCursor.toArray.mockResolvedValueOnce([
      {
        _id: 'origin-backoff',
        ownerId: 'owner-backoff',
        workRef: 'work-backoff',
        runId: 'run-backoff',
        externalState: 'running',
        launchState: 'accepted',
        stateReconciliationNextAt: new Date(Date.now() + 60_000),
      },
    ]);

    await reconcileKnownExternalWorkHints({ limit: 10 });

    expect(mockRequestAccountApi).not.toHaveBeenCalled();
    expect(mockExternalUpdateOne).not.toHaveBeenCalled();
  });

  test('keeps identical intentional calls distinct while a replay reuses its trusted ordinal', async () => {
    const requestBody = {
      messageId: 'assistant-anchor',
      parentMessageId: 'user-message',
      conversationId: 'conversation-1',
      viventiumSourceEventId: 'telegram:update:rapid-1',
      viventiumTriggeringSourceSegments: [
        { ordinal: 0, text: 'Research the same topic twice as separate missions.' },
      ],
    };
    const callA = { id: 'call-A', stepId: 'step-A', turn: 0 };
    const callB = { id: 'call-B', stepId: 'step-B', turn: 1 };

    expect(resolveTrustedGlassHiveCallIdentity({ requestBody, toolCall: callA })).toEqual(
      expect.objectContaining({ sourceEventId: 'telegram:update:rapid-1', objectiveOrdinal: 0 }),
    );
    expect(resolveTrustedGlassHiveCallIdentity({ requestBody, toolCall: callA })).toEqual(
      expect.objectContaining({ sourceEventId: 'telegram:update:rapid-1', objectiveOrdinal: 0 }),
    );
    expect(resolveTrustedGlassHiveCallIdentity({ requestBody, toolCall: callB })).toEqual(
      expect.objectContaining({ sourceEventId: 'telegram:update:rapid-1', objectiveOrdinal: 1 }),
    );

    const args = {
      description: 'Research the synthetic topic.',
      success_criteria: 'Return cited findings.',
      context: 'Keep each mission independent.',
      uploaded_files: [{ file_id: 'file-1', filename: 'brief.txt' }],
    };
    const first = await registerGlassHiveLaunchContext({
      user: { id: 'user-1' },
      requestBody,
      toolName: 'workspace_launch',
      toolArguments: args,
      toolCall: callA,
    });
    const replay = await registerGlassHiveLaunchContext({
      user: { id: 'user-1' },
      requestBody,
      toolName: 'workspace_launch',
      toolArguments: args,
      toolCall: callA,
    });
    const sibling = await registerGlassHiveLaunchContext({
      user: { id: 'user-1' },
      requestBody,
      toolName: 'workspace_launch',
      toolArguments: args,
      toolCall: callB,
    });

    expect(replay.originRef).toBe(first.originRef);
    expect(replay.delegationIdentity).toEqual(first.delegationIdentity);
    expect(sibling.originRef).not.toBe(first.originRef);
    expect(sibling.delegationIdentity.idempotency_key).not.toBe(
      first.delegationIdentity.idempotency_key,
    );
  });

  test('never projects ancestor chat into a durable delegation', async () => {
    mockGetMessageAncestorBranch.mockResolvedValue([
      {
        messageId: 'user-current',
        parentMessageId: 'assistant-old',
        isCreatedByUser: true,
        text: 'Current triggering request is projected separately.',
      },
      {
        messageId: 'system-row',
        parentMessageId: 'assistant-old',
        isCreatedByUser: false,
        sender: 'System',
        text: 'Hidden persona or system material.',
      },
      {
        messageId: 'assistant-old',
        parentMessageId: 'user-old',
        isCreatedByUser: false,
        text: '',
        content: [
          { type: 'tool_call', text: 'hidden tool internals' },
          { type: 'text', text: 'Visible Main answer.' },
        ],
      },
      {
        messageId: 'user-old',
        parentMessageId: 'root',
        isCreatedByUser: true,
        text: 'Earlier constraint from the user.',
      },
    ]);

    const toolArguments = {
      description: 'Create the exact selected-source report.',
      success_criteria: 'Return one Markdown file.',
      context: 'Use only the selected source.',
      uploaded_files: [{ file_id: 'selected-brief', filename: 'selected-brief.txt' }],
    };
    const launch = await registerGlassHiveLaunchContext({
      user: { id: 'user-1' },
      requestBody: {
        messageId: 'assistant-anchor',
        parentMessageId: 'user-current',
        conversationId: 'conversation-1',
        viventiumSourceEventId: 'telegram:event:context-1',
        viventiumTriggeringSourceSegments: [
          {
            source_event_id: 'telegram:event:context-1',
            source_index: 0,
            text: 'Current triggering request is projected separately.',
          },
        ],
      },
      toolName: 'workspace_launch',
      toolArguments,
      toolCall: { id: 'call-context-1' },
    });

    expect(mockGetMessageAncestorBranch).not.toHaveBeenCalled();
    expect(launch.delegationContext).not.toHaveProperty('recent_conversation');
    expect(launch.delegationContext.triggering_source_segments).toEqual([
      expect.objectContaining({
        ordinal: 0,
        text: 'Current triggering request is projected separately.',
      }),
    ]);
    const attached = attachGlassHiveTrustedLaunchMetadata(
      {
        ...toolArguments,
        context: `${toolArguments.context}\n\nHost capability brief added after registration.`,
        bootstrap_bundle_json: {
          glasshive_capability_broker: {
            version: 1,
            status: 'pending_admission',
            name: 'glasshive-user-capabilities',
            allowed_servers: ['synthetic-search'],
            allowed_host_tools: ['file_search'],
            scopes: { content_read: true },
          },
        },
      },
      launch,
      {
        glasshive_capability_broker: {
          version: 1,
          status: 'pending_admission',
          name: 'glasshive-user-capabilities',
          allowed_servers: ['synthetic-search'],
          allowed_host_tools: ['file_search'],
          scopes: { content_read: true },
        },
      },
    );
    expect(attached.bootstrap_bundle_json.viventium_delegation_packet).toMatchObject({
      task: {
        instruction: 'Create the exact selected-source report.',
        source_segments: [
          expect.objectContaining({
            ordinal: 0,
            text: 'Current triggering request is projected separately.',
          }),
        ],
      },
      explicit_constraints: [
        { kind: 'success_criteria', text: 'Return one Markdown file.' },
        { kind: 'context', text: 'Use only the selected source.' },
      ],
      selected_files: [{ ordinal: 0, name: 'selected-brief.txt' }],
      authorized_tool_context: {
        broker: 'glasshive-user-capabilities',
        status: 'pending_admission',
        servers: ['synthetic-search'],
        host_tools: ['file_search'],
        content_read: true,
      },
    });
    expect(
      JSON.stringify(attached.bootstrap_bundle_json.viventium_delegation_packet),
    ).not.toContain('Host capability brief');
    expect(JSON.stringify(launch.delegationContext)).not.toContain('hidden tool internals');
    expect(JSON.stringify(launch.delegationContext)).not.toContain('Hidden persona');
    expect(JSON.stringify(mockBindingUpdateOne.mock.calls)).not.toContain('Earlier constraint');
  });

  test('delegation preparation does no work proportional to conversation history', async () => {
    const boundedBranch = Array.from({ length: 33 }, (_, index) => ({
      messageId: `branch-${32 - index}`,
      parentMessageId: index === 32 ? 'root' : `branch-${31 - index}`,
      isCreatedByUser: index % 2 === 0,
      text: `Relevant branch message ${index}`,
    }));
    mockGetMessageAncestorBranch.mockResolvedValue(boundedBranch);

    const startedAt = performance.now();
    const launch = await registerGlassHiveLaunchContext({
      user: { id: 'user-large-thread' },
      requestBody: {
        messageId: 'assistant-anchor-large',
        parentMessageId: 'branch-32',
        conversationId: 'conversation-with-100k-off-branch-messages',
        viventiumSourceEventId: 'web:event:large-thread',
        viventiumTriggeringSourceSegments: [{ ordinal: 0, text: 'Use this exact branch.' }],
      },
      toolName: 'workspace_launch',
      toolArguments: { description: 'Prepare from the exact relevant branch.' },
      toolCall: { id: 'call-large-thread' },
    });
    const elapsedMs = performance.now() - startedAt;

    expect(mockGetMessageAncestorBranch).not.toHaveBeenCalled();
    expect(launch.delegationContext).not.toHaveProperty('recent_conversation');
    expect(elapsedMs).toBeLessThan(50);
  });

  test('reconstructs the same call identity after restart even when sibling invocation order changes', async () => {
    const requestA = {
      messageId: 'assistant-anchor',
      conversationId: 'conversation-1',
      viventiumSourceEventId: 'telegram:update:restart-1',
      viventiumTriggeringSourceSegments: [{ ordinal: 0, text: 'Launch both missions.' }],
    };
    const reconstructedRequest = { ...requestA };
    const callA = { id: 'call-stable-A', stepId: 'step-stable-A', turn: 0 };
    const callB = { id: 'call-stable-B', stepId: 'step-stable-B', turn: 1 };

    const firstA = resolveTrustedGlassHiveCallIdentity({ requestBody: requestA, toolCall: callA });
    const firstB = resolveTrustedGlassHiveCallIdentity({ requestBody: requestA, toolCall: callB });
    const reorderedB = resolveTrustedGlassHiveCallIdentity({
      requestBody: reconstructedRequest,
      toolCall: callB,
    });
    const reconstructedA = resolveTrustedGlassHiveCallIdentity({
      requestBody: reconstructedRequest,
      toolCall: callA,
    });

    expect(reconstructedA).toEqual(firstA);
    expect(reorderedB).toEqual(firstB);

    const firstLaunch = await registerGlassHiveLaunchContext({
      user: { id: 'user-1' },
      requestBody: requestA,
      toolName: 'workspace_launch',
      toolArguments: { description: 'Run the identical synthetic objective.' },
      toolCall: callA,
    });
    const reconstructedLaunch = await registerGlassHiveLaunchContext({
      user: { id: 'user-1' },
      requestBody: reconstructedRequest,
      toolName: 'workspace_launch',
      toolArguments: { description: 'Run the identical synthetic objective.' },
      toolCall: callA,
    });

    expect(reconstructedLaunch.originRef).toBe(firstLaunch.originRef);
    expect(reconstructedLaunch.delegationIdentity.idempotency_key).toBe(
      firstLaunch.delegationIdentity.idempotency_key,
    );
  });

  test('binds the full objective and file references without storing their raw values', async () => {
    const requestBody = {
      messageId: 'assistant-anchor',
      conversationId: 'conversation-1',
      viventiumSourceEventId: 'web:event:objective-1',
    };
    const base = {
      description: 'Create the report.',
      success_criteria: 'The report is complete.',
      context: 'Use the supplied evidence and retain exclusions.',
      title: 'Synthetic report',
      uploaded_files: [{ file_id: 'file-1', filename: 'brief.txt', text: 'private body A' }],
    };
    const first = await registerGlassHiveLaunchContext({
      user: { id: 'user-1' },
      requestBody,
      toolName: 'workspace_launch',
      toolArguments: base,
      toolCall: { id: 'call-objective-1' },
    });
    const changed = await registerGlassHiveLaunchContext({
      user: { id: 'user-1' },
      requestBody,
      toolName: 'workspace_launch',
      toolArguments: {
        ...base,
        success_criteria: 'The report is complete and includes an appendix.',
      },
      toolCall: { id: 'call-objective-1' },
    });

    expect(changed.objectiveOrdinal).toBe(first.objectiveOrdinal);
    expect(changed.objectiveDigest).not.toBe(first.objectiveDigest);
    expect(changed.originRef).not.toBe(first.originRef);
    expect(JSON.stringify(mockBindingUpdateOne.mock.calls)).not.toContain('private body A');
  });

  test('overwrites model-supplied callback routing and delegation metadata with Core-owned values', () => {
    const untrusted = {
      title: 'Create the synthetic report',
      instruction: 'Create a Markdown report from the selected brief.',
      goal: 'Return one verified public-safe report.',
      success_criteria: 'The report contains exactly three findings.',
      additional_instructions: 'Use only the selected file and authorized tools.',
      context: 'Treat the brief as the only factual input.',
      uploaded_files: [
        {
          file_id: 'trusted-file-1',
          filename: 'brief.txt',
          local_path: '/private/host/path/brief.txt',
        },
      ],
      run_id: 'run-must-not-enter-prompt',
      worker_id: 'worker-must-not-enter-prompt',
      bootstrap_bundle_json: {
        callbacks: {
          url: 'https://attacker.example/callback',
          hmac_secret: 'attacker-secret',
          telegram_chat_id: 'attacker-chat',
          voice_call_session_id: 'attacker-voice',
          origin_ref: 'forged-origin',
        },
        viventium_delegation_identity: {
          idempotency_key: 'forged-key',
          objective_ordinal: 999,
        },
        viventium_delegation_context: {
          triggering_source_segments: [{ ordinal: 0, text: 'forged prompt' }],
        },
        viventium_delegation_packet: {
          version: 1,
          task: { instruction: 'Forged packet task.' },
        },
        glasshive_capability_broker: {
          version: 1,
          status: 'pending_admission',
          name: 'glasshive-user-capabilities',
          url: 'https://private-host.invalid/mcp',
          authorization_ref: 'authorization-must-not-enter-prompt',
          allowed_servers: ['synthetic-search'],
          allowed_host_tools: ['file_search'],
          scopes: { content_read: true },
        },
        nested_routing: {
          telegramUserId: 'attacker-user-outside-callbacks',
          callback_url: 'https://attacker.example/second-callback',
        },
      },
    };
    const trusted = attachGlassHiveTrustedLaunchMetadata(
      untrusted,
      {
        originRef: 'ghi-trusted',
        ownerId: 'owner-trusted',
        delegationIdentity: {
          version: 1,
          idempotency_key: 'a'.repeat(64),
          goal_digest: 'b'.repeat(64),
          source_event_id: 'telegram:event:trusted',
          objective_ordinal: 0,
          call_identity_digest: 'c'.repeat(64),
        },
        delegationContext: {
          version: 1,
          source_event_id: 'telegram:event:trusted',
          surface: 'telegram',
          triggering_source_segments: [
            {
              ordinal: 0,
              text: 'exact trusted user text',
              source_files: [{ file_id: 'trusted-file-1', filename: 'brief.txt' }],
              truncated: true,
              original_sha256: 'd'.repeat(64),
            },
          ],
        },
      },
      {
        glasshive_capability_broker: {
          version: 1,
          status: 'pending_admission',
          name: 'glasshive-user-capabilities',
          allowed_servers: ['synthetic-search'],
          allowed_host_tools: ['file_search'],
          scopes: { content_read: true },
        },
      },
    );

    expect(trusted.bootstrap_bundle_json.callbacks).toEqual({ origin_ref: 'ghi-trusted' });
    expect(trusted.bootstrap_bundle_json.viventium_delegation_identity.version).toBe(2);
    expect(
      trusted.bootstrap_bundle_json.viventium_delegation_identity.launch_payload_digest,
    ).toMatch(/^[a-f0-9]{64}$/);
    expect(trusted.bootstrap_bundle_json.viventium_delegation_identity.launch_payload_digest).toBe(
      '9cd5f67197754e50660779a8c400071f984cfd5e2b6c2cb54306ec2208011b6a',
    );
    expect(trusted.bootstrap_bundle_json.viventium_delegation_identity.objective_ordinal).toBe(0);
    expect(trusted.bootstrap_bundle_json.viventium_delegation_assertion).toBe('f'.repeat(64));
    expect(
      trusted.bootstrap_bundle_json.viventium_delegation_context.triggering_source_segments,
    ).toEqual([
      {
        ordinal: 0,
        source_event_id: 'telegram:event:trusted',
        source_index: 0,
        text: 'exact trusted user text',
        truncated: true,
        original_sha256: 'd'.repeat(64),
      },
    ]);
    expect(
      Object.keys(
        trusted.bootstrap_bundle_json.viventium_delegation_context.triggering_source_segments[0],
      ).sort(),
    ).toEqual(
      ['ordinal', 'source_event_id', 'source_index', 'text', 'truncated', 'original_sha256'].sort(),
    );
    expect(trusted.bootstrap_bundle_json.viventium_delegation_packet).toEqual({
      version: 1,
      task: {
        title: 'Create the synthetic report',
        instruction: 'Create a Markdown report from the selected brief.',
        goal: 'Return one verified public-safe report.',
        source_segments: [
          {
            ordinal: 0,
            text: 'exact trusted user text',
            truncated: true,
            original_sha256: 'd'.repeat(64),
          },
        ],
      },
      explicit_constraints: [
        {
          kind: 'success_criteria',
          text: 'The report contains exactly three findings.',
        },
        {
          kind: 'additional_instructions',
          text: 'Use only the selected file and authorized tools.',
        },
        { kind: 'context', text: 'Treat the brief as the only factual input.' },
      ],
      selected_files: [{ ordinal: 0, name: 'brief.txt' }],
      authorized_tool_context: {
        broker: 'glasshive-user-capabilities',
        status: 'pending_admission',
        servers: ['synthetic-search'],
        host_tools: ['file_search'],
        content_read: true,
      },
    });
    expect(trusted.uploaded_files).toEqual(untrusted.uploaded_files);
    const packetText = JSON.stringify(trusted.bootstrap_bundle_json.viventium_delegation_packet);
    expect(packetText).not.toContain('run-must-not-enter-prompt');
    expect(packetText).not.toContain('worker-must-not-enter-prompt');
    expect(packetText).not.toContain('/private/host/path');
    expect(packetText).not.toContain('private-host.invalid');
    expect(packetText).not.toContain('authorization-must-not-enter-prompt');
    expect(JSON.stringify(trusted)).not.toContain('attacker.example');
    expect(JSON.stringify(trusted)).not.toContain('attacker-secret');
    expect(JSON.stringify(trusted)).not.toContain('attacker-chat');
    expect(JSON.stringify(trusted)).not.toContain('attacker-voice');
    expect(JSON.stringify(trusted)).not.toContain('attacker-user-outside-callbacks');
    expect(JSON.stringify(trusted)).not.toContain('second-callback');
    expect(JSON.stringify(trusted)).not.toContain('system_instructions');
    expect(JSON.stringify(trusted)).not.toContain('recent_chat');
    expect(JSON.stringify(trusted)).not.toContain('host_identifier');
    expect(JSON.stringify(attachGlassHiveLaunchOrigin(untrusted, 'ghi-trusted'))).not.toContain(
      'attacker.example',
    );
  });

  test('resolves by launch origin, verifies the authoritative GlassHive association, and ignores callback targets', async () => {
    mockBindingFindOne.mockResolvedValue({
      _id: 'ghi-origin-1',
      originRef: 'ghi-origin-1',
      workRef: '',
      ownerId: 'user-1',
      conversationId: 'conversation-1',
      anchorMessageId: 'assistant-anchor',
      requestedParentMessageId: 'user-message',
      configuredDestinations: [{ surface: 'telegram' }, { surface: 'librechat' }],
      scheduleOccurrenceKey: 'schedule:occurrence-1',
    });

    const resolved = await resolveGlassHiveCallbackContext({
      origin_ref: 'ghi-origin-1',
      work_ref: 'gh-work-1',
      worker_id: 'worker-1',
      run_id: 'run-1',
      callback_id: 'raw-callback-1',
      attempt_number: 1,
      user_id: 'user-1',
      conversation_id: 'conversation-1',
      message_id: 'assistant-anchor',
      parent_message_id: 'forged-parent',
      surface: 'telegram',
      telegram_chat_id: 'attacker-chat',
      telegram_user_id: 'attacker-user',
    });

    expect(mockBindingFindOne).toHaveBeenCalledWith({ _id: 'ghi-origin-1' });
    expect(mockRequestAccountApi).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: 'user-1',
        path: '/v1/callback-associations/verify',
        method: 'POST',
        body: {
          originRef: 'ghi-origin-1',
          workRef: 'gh-work-1',
          workerId: 'worker-1',
          runId: 'run-1',
        },
      }),
    );
    expect(mockBindingUpdateOne).toHaveBeenCalledWith(
      { _id: 'ghi-origin-1', $or: [{ workRef: '' }, { workRef: 'gh-work-1' }] },
      expect.objectContaining({
        $set: expect.objectContaining({
          workRef: 'gh-work-1',
          launchState: 'callback_confirmed',
        }),
      }),
    );
    expect(resolved.requestedParentMessageId).toBe('user-message');
    expect(resolved.traceIdentity).toEqual({
      attemptNumber: 1,
      callbackRef: expect.stringMatching(/^callback_sha256:[a-f0-9]{64}$/),
    });
    expect(resolved.destinations).toEqual([
      {
        surface: 'telegram',
        telegramChatId: 'telegram-authoritative',
        telegramUserId: 'telegram-authoritative',
      },
      { surface: 'librechat' },
    ]);
    expect(JSON.stringify(resolved)).not.toContain('attacker-chat');
    expect(JSON.stringify(resolved)).not.toContain('attacker-user');
  });

  test('can defer all callback-confirmation writes until the route result CAS succeeds', async () => {
    mockBindingFindOne.mockResolvedValue({
      _id: 'ghi-origin-1',
      originRef: 'ghi-origin-1',
      workRef: '',
      ownerId: 'user-1',
      conversationId: 'conversation-1',
      anchorMessageId: 'assistant-anchor',
      requestedParentMessageId: 'user-message',
      configuredDestinations: [{ surface: 'librechat' }],
    });
    const body = {
      origin_ref: 'ghi-origin-1',
      work_ref: 'gh-work-1',
      worker_id: 'worker-1',
      run_id: 'run-1',
    };

    const resolved = await resolveGlassHiveCallbackContext(body, { deferConfirmation: true });

    expect(resolved).toEqual(expect.objectContaining({ ownerId: 'user-1' }));
    expect(mockBindingUpdateOne).not.toHaveBeenCalled();
    expect(mockExternalUpdateOne).not.toHaveBeenCalled();
    expect(mockRecordTraceAcceptedLaunch).not.toHaveBeenCalled();

    await confirmGlassHiveCallbackContext({ binding: resolved, body });

    expect(mockBindingUpdateOne).toHaveBeenCalledTimes(1);
    expect(mockExternalUpdateOne).toHaveBeenCalledTimes(1);
    expect(mockRecordTraceAcceptedLaunch).toHaveBeenCalledTimes(1);
  });

  test('makes callback confirmation destinations consume the exact result operation generation', async () => {
    mockExternalUpdateOne.mockResolvedValueOnce({ acknowledged: true, matchedCount: 1 });
    mockBindingUpdateOne.mockResolvedValueOnce({ acknowledged: true, matchedCount: 1 });
    const body = {
      origin_ref: 'ghi-origin-1',
      work_ref: 'gh-work-1',
      worker_id: 'worker-1',
      run_id: 'run-1',
      callback_id: `cb_terminal_${'a'.repeat(64)}`,
      result_ended_at: '2026-08-27T12:00:17.618Z',
      result_revision: 2,
      result_digest: `sha256:${'b'.repeat(64)}`,
    };
    const effectFence = {
      resultKey: `ghtr_${'e'.repeat(64)}`,
      callbackId: body.callback_id,
      resultRevision: body.result_revision,
      resultDigest: body.result_digest,
      acceptedOperationId: 'c'.repeat(32),
      leaseId: 'd'.repeat(32),
      generation: 3,
    };

    await confirmGlassHiveCallbackContext({
      binding: { ownerId: 'user-1', originRef: 'ghi-origin-1', workRef: 'gh-work-1' },
      body,
      effectFence,
    });

    expect(mockExternalUpdateOne.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        $and: expect.arrayContaining([
          expect.objectContaining({ _id: 'ghi-origin-1' }),
          expect.objectContaining({ $or: expect.any(Array) }),
        ]),
      }),
    );
    expect(mockExternalUpdateOne.mock.calls[0][1].$set).toEqual(
      expect.objectContaining({
        terminalCallbackResultRevision: 2,
        terminalCallbackId: body.callback_id,
        terminalCallbackResultDigest: body.result_digest,
        terminalCallbackRunId: body.run_id,
        terminalCallbackResultEndedAt: new Date(body.result_ended_at),
        terminalCallbackAcceptedOperationId: effectFence.acceptedOperationId,
        terminalCallbackEffectLeaseId: effectFence.leaseId,
        terminalCallbackEffectLeaseGeneration: 3,
      }),
    );
    expect(mockBindingUpdateOne.mock.calls[0][1].$set).toEqual(
      expect.objectContaining({ terminalCallbackResultRevision: 2 }),
    );
  });

  test('stops confirmation before later effects when its destination generation is stale', async () => {
    const body = {
      work_ref: 'gh-work-1',
      worker_id: 'worker-1',
      run_id: 'run-1',
      callback_id: `cb_terminal_${'a'.repeat(64)}`,
      result_ended_at: '2026-08-27T12:00:17.618Z',
      result_revision: 1,
      result_digest: `sha256:${'b'.repeat(64)}`,
    };
    mockExternalUpdateOne.mockResolvedValueOnce({ acknowledged: true, matchedCount: 0 });

    await expect(
      confirmGlassHiveCallbackContext({
        binding: { ownerId: 'user-1', originRef: 'ghi-origin-1', workRef: 'gh-work-1' },
        body,
        effectFence: {
          resultKey: `ghtr_${'e'.repeat(64)}`,
          callbackId: body.callback_id,
          resultRevision: body.result_revision,
          resultDigest: body.result_digest,
          acceptedOperationId: 'c'.repeat(32),
          leaseId: 'd'.repeat(32),
          generation: 1,
        },
      }),
    ).rejects.toMatchObject({ code: 'glasshive_callback_effect_fenced' });
    expect(mockBindingUpdateOne).not.toHaveBeenCalled();
    expect(mockRecordTraceAcceptedLaunch).not.toHaveBeenCalled();
  });

  test('refuses a callback whose durable origin has no persisted launch intent', async () => {
    mockBindingFindOne.mockResolvedValue(null);

    await expect(
      resolveGlassHiveCallbackContext({
        origin_ref: 'ghi-unbound',
        work_ref: 'gh-work-1',
        worker_id: 'worker-1',
        run_id: 'run-1',
        user_id: 'user-1',
        conversation_id: 'conversation-1',
        message_id: 'unbound-anchor',
        surface: 'telegram',
        telegram_chat_id: 'untrusted-chat',
      }),
    ).resolves.toBeNull();
    expect(mockResolveTelegramMappingByUserId).not.toHaveBeenCalled();
    expect(mockRequestAccountApi).not.toHaveBeenCalled();
  });

  test('fails closed when GlassHive does not verify the exact work/worker/run association', async () => {
    mockBindingFindOne.mockResolvedValue({
      _id: 'ghi-origin-1',
      originRef: 'ghi-origin-1',
      workRef: 'gh-work-1',
      ownerId: 'user-1',
      conversationId: 'conversation-1',
      anchorMessageId: 'assistant-anchor',
      requestedParentMessageId: 'user-message',
      configuredDestinations: [{ surface: 'librechat' }],
    });
    const rejected = new Error('callback_association_not_found');
    rejected.status = 404;
    mockRequestAccountApi.mockRejectedValue(rejected);

    await expect(
      resolveGlassHiveCallbackContext({
        origin_ref: 'ghi-origin-1',
        work_ref: 'gh-work-1',
        worker_id: 'worker-forged',
        run_id: 'run-forged',
        user_id: 'attacker',
        conversation_id: 'attacker-conversation',
      }),
    ).resolves.toBeNull();
  });

  test('binds an authoritative launch response and preserves an unknown dispatch for callback repair', async () => {
    mockBindingFindOne.mockResolvedValueOnce({ ownerId: 'owner-launch' });
    await reconcileGlassHiveLaunchResult({
      toolArguments: {
        bootstrap_bundle_json: { callbacks: { origin_ref: 'ghi-origin-1' } },
      },
      result: [
        { type: 'text', text: JSON.stringify({ status: 'dispatched', work_ref: 'gh-work-1' }) },
      ],
    });

    expect(mockBindingUpdateOne).toHaveBeenCalledWith(
      { _id: 'ghi-origin-1', $or: [{ workRef: '' }, { workRef: 'gh-work-1' }] },
      expect.objectContaining({
        $set: expect.objectContaining({ workRef: 'gh-work-1', launchState: 'accepted' }),
      }),
    );
    expect(mockExternalUpdateOne).toHaveBeenCalledWith(
      { _id: 'ghi-origin-1', $or: [{ workRef: '' }, { workRef: 'gh-work-1' }] },
      expect.objectContaining({ $set: expect.objectContaining({ workRef: 'gh-work-1' }) }),
    );
    expect(mockRecordTraceAcceptedLaunch).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: 'owner-launch',
        originRef: 'ghi-origin-1',
        workRef: 'gh-work-1',
      }),
    );

    await markGlassHiveLaunchDispatchUnknown({
      bootstrap_bundle_json: { callbacks: { origin_ref: 'ghi-origin-2' } },
    });
    expect(mockBindingUpdateOne).toHaveBeenLastCalledWith(
      { _id: 'ghi-origin-2', launchState: { $in: ['prepared', 'dispatch_ready'] } },
      expect.objectContaining({
        $set: expect.objectContaining({ launchState: 'dispatch_unknown' }),
      }),
    );
  });

  test('sets known-work only at dispatch readiness and closes a pre-dispatch failure terminally', async () => {
    await markGlassHiveLaunchDispatchReady({
      originRef: 'ghi-prepared',
      ownerId: 'owner-ready',
    });
    expect(mockBindingUpdateOne).toHaveBeenCalledWith(
      {
        _id: 'ghi-prepared',
        workRef: '',
        launchState: { $in: ['prepared', 'not_dispatched'] },
      },
      expect.objectContaining({
        $set: expect.objectContaining({ launchState: 'dispatch_ready' }),
      }),
    );
    expect(mockMarkUserParallelWorkKnown).toHaveBeenCalledWith('owner-ready');
    mockMarkUserParallelWorkKnown.mockClear();

    mockExternalFindOne.mockResolvedValueOnce(null);
    await markGlassHiveLaunchPreDispatchFailed(
      { originRef: 'ghi-prepared', ownerId: 'owner-ready', required: false },
      Object.assign(new Error('broker unavailable'), { code: 'broker_unavailable' }),
    );
    expect(mockExternalUpdateOne).toHaveBeenLastCalledWith(
      {
        _id: 'ghi-prepared',
        workRef: '',
        launchState: { $in: ['prepared', 'dispatch_ready', 'dispatch_unknown'] },
      },
      expect.objectContaining({
        $set: expect.objectContaining({
          launchState: 'not_dispatched',
          externalState: 'failed',
          preDispatchFailureCode: 'broker_unavailable',
          attentionPending: true,
          deliveryState: 'failed',
          terminalAt: expect.any(Date),
        }),
      }),
    );
    expect(mockMarkUserParallelWorkKnown).toHaveBeenCalledTimes(1);
    expect(mockMarkUserParallelWorkKnown).toHaveBeenCalledWith('owner-ready');
    expect(mockRecordTraceFailedLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'owner-ready', originRef: 'ghi-prepared' }),
    );
  });

  test('fails dispatch readiness closed when the durable positive fence cannot be published', async () => {
    mockMarkUserParallelWorkKnown.mockResolvedValueOnce(false);

    await expect(
      markGlassHiveLaunchDispatchReady({
        originRef: 'ghi-fence-failed',
        ownerId: 'owner-fence-failed',
      }),
    ).rejects.toMatchObject({ code: 'parallel_work_positive_fence_failed' });

    expect(mockMarkUserParallelWorkKnown).toHaveBeenCalledWith('owner-fence-failed');
  });

  test('surfaces a failed best-effort positive repair after pre-dispatch cleanup', async () => {
    mockExternalFindOne.mockResolvedValueOnce({ _id: 'other-active-work' });
    mockMarkUserParallelWorkKnown.mockResolvedValueOnce(false);

    await expect(
      markGlassHiveLaunchPreDispatchFailed(
        { originRef: 'ghi-cleanup-fence', ownerId: 'owner-cleanup-fence', required: false },
        Object.assign(new Error('synthetic preparation failure'), {
          code: 'synthetic_preparation_failure',
        }),
      ),
    ).rejects.toMatchObject({ code: 'parallel_work_positive_fence_failed' });

    expect(mockExternalUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'ghi-cleanup-fence' }),
      expect.objectContaining({
        $set: expect.objectContaining({ launchState: 'not_dispatched' }),
      }),
    );
    expect(mockMarkUserParallelWorkKnown).toHaveBeenCalledWith('owner-cleanup-fence');
  });

  test('a required scheduled pre-dispatch failure closes waiting_external truth', async () => {
    const originalUrl = process.env.VIVENTIUM_SCHEDULING_EXTERNAL_WORK_CALLBACK_URL;
    const originalSecret = process.env.VIVENTIUM_SCHEDULER_SECRET;
    const originalFetch = global.fetch;
    process.env.VIVENTIUM_SCHEDULING_EXTERNAL_WORK_CALLBACK_URL =
      'http://scheduler.example/internal/scheduled-prompts/external-work-callback';
    process.env.VIVENTIUM_SCHEDULER_SECRET = 'synthetic-scheduler-secret';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ accepted: true }),
    });
    mockExternalFindOne.mockResolvedValueOnce(null);
    mockExternalFind.mockReturnValueOnce({
      toArray: jest
        .fn()
        .mockResolvedValue([{ _id: 'ghi-scheduled', required: true, externalState: 'failed' }]),
    });

    try {
      await markGlassHiveLaunchPreDispatchFailed(
        {
          originRef: 'ghi-scheduled',
          ownerId: 'owner-scheduled',
          required: true,
          schedulerDispatchDocumentId: 'dispatch-scheduled',
          scheduleOccurrenceKey: 'occurrence-scheduled',
        },
        Object.assign(new Error('authorization unavailable'), {
          code: 'authorization_prepare_failed',
        }),
      );

      expect(global.fetch).toHaveBeenCalledWith(
        'http://scheduler.example/internal/scheduled-prompts/external-work-callback',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"state":"failed"'),
        }),
      );
    } finally {
      if (originalUrl == null) {
        delete process.env.VIVENTIUM_SCHEDULING_EXTERNAL_WORK_CALLBACK_URL;
      } else {
        process.env.VIVENTIUM_SCHEDULING_EXTERNAL_WORK_CALLBACK_URL = originalUrl;
      }
      if (originalSecret == null) {
        delete process.env.VIVENTIUM_SCHEDULER_SECRET;
      } else {
        process.env.VIVENTIUM_SCHEDULER_SECRET = originalSecret;
      }
      global.fetch = originalFetch;
    }
  });

  test('reconciles a lost launch response from GlassHive origin lookup without creating new work', async () => {
    mockExternalCursor.toArray.mockResolvedValueOnce([
      {
        _id: 'ghi-origin-unknown',
        originRef: 'ghi-origin-unknown',
        ownerId: 'user-1',
        launchState: 'dispatch_ready',
        dispatchExpiresAt: new Date(0),
      },
    ]);
    mockRequestAccountApi.mockResolvedValueOnce({ workRef: 'gh-work-recovered' });

    await expect(reconcileUnknownGlassHiveLaunches({ ownerId: 'user-1' })).resolves.toEqual({
      scanned: 1,
      repaired: 1,
      pending: 0,
    });
    expect(mockRequestAccountApi).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: 'user-1',
        path: '/v1/delegations/by-origin/ghi-origin-unknown',
      }),
    );
    expect(mockBindingUpdateOne).toHaveBeenCalledWith(
      {
        _id: 'ghi-origin-unknown',
        $or: [{ workRef: '' }, { workRef: 'gh-work-recovered' }],
      },
      expect.objectContaining({
        $set: expect.objectContaining({
          workRef: 'gh-work-recovered',
          launchState: 'accepted',
        }),
      }),
    );
  });

  test('backs off a transient poison row and continues repairing later launch intents', async () => {
    mockExternalCursor.toArray.mockResolvedValueOnce([
      {
        _id: 'ghi-transient-poison',
        originRef: 'ghi-transient-poison',
        ownerId: 'user-poison',
        launchState: 'dispatch_unknown',
        reconciliationAttempts: 2,
      },
      {
        _id: 'ghi-repairable-after-poison',
        originRef: 'ghi-repairable-after-poison',
        ownerId: 'user-healthy',
        launchState: 'dispatch_unknown',
      },
    ]);
    mockRequestAccountApi
      .mockRejectedValueOnce(Object.assign(new Error('provider unavailable'), { status: 503 }))
      .mockResolvedValueOnce({ workRef: 'gh-work-after-poison' });

    await expect(reconcileUnknownGlassHiveLaunches()).resolves.toEqual({
      scanned: 2,
      repaired: 1,
      pending: 1,
    });
    expect(mockRequestAccountApi).toHaveBeenCalledTimes(2);
    expect(mockExternalUpdateOne).toHaveBeenCalledWith(
      {
        _id: 'ghi-transient-poison',
        workRef: '',
        launchState: 'dispatch_unknown',
      },
      {
        $set: expect.objectContaining({
          reconciliationAttemptedAt: expect.any(Date),
          reconciliationNextAt: expect.any(Date),
          reconciliationErrorCode: 'Error',
        }),
        $inc: { reconciliationAttempts: 1 },
      },
    );
    expect(mockBindingUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'ghi-repairable-after-poison' }),
      expect.objectContaining({
        $set: expect.objectContaining({ workRef: 'gh-work-after-poison' }),
      }),
    );
  });

  test('startup reconciliation closes a crash-left prepared intent without querying GlassHive', async () => {
    mockExternalCursor.toArray.mockResolvedValueOnce([
      {
        _id: 'ghi-crash-after-register',
        originRef: 'ghi-crash-after-register',
        ownerId: 'user-crash',
        launchState: 'prepared',
        required: false,
      },
    ]);
    mockExternalFindOne.mockResolvedValueOnce(null);

    await expect(reconcileUnknownGlassHiveLaunches()).resolves.toEqual({
      scanned: 1,
      repaired: 1,
      pending: 0,
    });

    expect(mockRequestAccountApi).not.toHaveBeenCalled();
    expect(mockExternalUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: 'ghi-crash-after-register',
        launchState: { $in: ['prepared', 'dispatch_ready', 'dispatch_unknown'] },
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          externalState: 'failed',
          launchState: 'not_dispatched',
          preDispatchFailureCode: 'launch_preparation_lease_expired',
        }),
      }),
    );
    expect(mockExternalFind.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        workRef: '',
        $or: expect.arrayContaining([
          expect.objectContaining({ launchState: 'dispatch_unknown' }),
          expect.objectContaining({
            launchState: 'prepared',
            preparationExpiresAt: { $lte: expect.any(Date) },
          }),
        ]),
      }),
    );
  });

  test('startup reconciliation closes crash-after-ready only after GlassHive verifies no mission', async () => {
    mockExternalCursor.toArray.mockResolvedValueOnce([
      {
        _id: 'ghi-crash-after-ready',
        originRef: 'ghi-crash-after-ready',
        ownerId: 'user-ready-crash',
        launchState: 'dispatch_ready',
        dispatchExpiresAt: new Date(0),
        updatedAt: new Date(0),
        required: false,
      },
    ]);
    mockRequestAccountApi.mockRejectedValueOnce(
      Object.assign(new Error('delegation_not_found'), { status: 404 }),
    );
    mockExternalFindOne.mockResolvedValueOnce(null);

    await expect(reconcileUnknownGlassHiveLaunches()).resolves.toEqual({
      scanned: 1,
      repaired: 1,
      pending: 0,
    });

    expect(mockRequestAccountApi).toHaveBeenCalledWith({
      ownerId: 'user-ready-crash',
      path: '/v1/delegations/by-origin/ghi-crash-after-ready',
      timeoutMs: 3000,
    });
    expect(mockExternalUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: 'ghi-crash-after-ready',
        launchState: { $in: ['prepared', 'dispatch_ready', 'dispatch_unknown'] },
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          launchState: 'not_dispatched',
          externalState: 'failed',
          preDispatchFailureCode: 'launch_dispatch_not_found',
        }),
      }),
    );
  });

  test('keeps terminal external work monotonic and reports all-required completion', async () => {
    const completedDetail = {
      workRef: 'gh-work-1',
      runRef: 'run_sha256:' + 'a'.repeat(64),
      state: 'completed',
    };
    mockRequestAccountApi.mockResolvedValueOnce(completedDetail);
    mockExternalFindOne.mockResolvedValueOnce({ _id: 'work-1', externalState: 'accepted' });
    mockExternalFindOneAndUpdate.mockResolvedValue({
      _id: 'work-1',
      required: true,
      externalState: 'completed',
      runId: 'run-1',
    });
    mockExternalFind.mockReturnValue({
      toArray: jest.fn().mockResolvedValue([
        { _id: 'work-1', required: true, externalState: 'completed' },
        { _id: 'work-2', required: true, externalState: 'failed' },
        { _id: 'work-info', required: false, externalState: 'running' },
      ]),
    });

    const binding = {
      originRef: 'work-1',
      workRef: 'gh-work-1',
      ownerId: 'user-1',
      traceIdentity: {
        callbackRef: canonicalCallbackRef('raw-terminal-callback'),
        attemptNumber: 1,
      },
      conversationId: 'conversation-1',
      anchorMessageId: 'assistant-anchor',
      scheduleOccurrenceKey: 'schedule:occurrence-1',
      schedulerDispatchDocumentId: 'dispatch-doc-1',
    };
    const result = await recordGlassHiveCallbackExternalState({
      binding,
      body: {
        event: 'run.completed',
        work_state: 'completed',
        work_terminal: true,
        callback_ts: 1_700_000_000,
        callback_id: 'raw-terminal-callback',
        attempt_number: 1,
        worker_id: 'worker-1',
        run_id: 'run-1',
      },
    });

    expect(mockExternalFindOneAndUpdate.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        _id: 'work-1',
        externalState: { $nin: ['completed', 'failed', 'cancelled'] },
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        requiredTotal: 2,
        requiredTerminal: 2,
        requiredFailed: 1,
        allRequiredTerminal: true,
      }),
    );
    expect(mockRecordTraceCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: 'user-1',
        originRef: 'work-1',
        workRef: 'gh-work-1',
        runRef: 'run-1',
        callbackRef: expect.stringMatching(/^callback_sha256:[a-f0-9]{64}$/),
        attemptNumber: 1,
        event: 'run.completed',
        workState: 'completed',
        workTerminal: true,
        callbackAt: new Date(1_700_000_000_000),
        callbackAcceptedAt: expect.any(Date),
      }),
    );
    expect(mockRecordTraceCallback.mock.calls[0][0].callbackAcceptedAt.getTime()).toBeGreaterThan(
      1_700_000_000_000,
    );
    expect(mockRequestAccountApi).toHaveBeenCalledWith({
      ownerId: 'user-1',
      path: '/v1/work/gh-work-1',
      timeoutMs: 3000,
    });
    expect(mockRecordGlassHiveWorkDetailTrace).toHaveBeenCalledWith({
      ownerId: 'user-1',
      originRef: 'work-1',
      workRef: 'gh-work-1',
      runRef: 'run-1',
      detail: completedDetail,
    });
    expect(mockRecordGlassHiveWorkDetailTrace.mock.invocationCallOrder[0]).toBeLessThan(
      mockRecordTraceCallback.mock.invocationCallOrder[0],
    );
  });

  test('rejects completed callback evidence when trusted producer detail is unavailable', async () => {
    mockRequestAccountApi.mockRejectedValueOnce(new Error('producer_detail_unavailable'));

    await expect(
      recordGlassHiveCallbackExternalState({
        binding: {
          originRef: 'work-producer-missing',
          workRef: 'gh-work-producer-missing',
          ownerId: 'user-1',
          traceIdentity: {
            callbackRef: canonicalCallbackRef('raw-producer-missing-callback'),
            attemptNumber: 1,
          },
        },
        body: {
          event: 'run.completed',
          work_state: 'completed',
          work_terminal: true,
          callback_ts: 1_700_000_000,
          callback_id: 'raw-producer-missing-callback',
          attempt_number: 1,
          worker_id: 'worker-1',
          run_id: 'run-producer-missing',
        },
      }),
    ).rejects.toThrow('producer_detail_unavailable');
    expect(mockRecordGlassHiveWorkDetailTrace).not.toHaveBeenCalled();
    expect(mockRecordTraceCallback).not.toHaveBeenCalled();
  });

  test('rejects completed callback evidence when trusted producer detail fails validation', async () => {
    mockRequestAccountApi.mockResolvedValueOnce({ state: 'completed' });
    mockRecordGlassHiveWorkDetailTrace.mockResolvedValueOnce({
      accepted: false,
      errors: ['attempt_history_missing'],
      eventCount: 0,
    });

    await expect(
      recordGlassHiveCallbackExternalState({
        binding: {
          originRef: 'work-producer-invalid',
          workRef: 'gh-work-producer-invalid',
          ownerId: 'user-1',
          traceIdentity: {
            callbackRef: canonicalCallbackRef('raw-producer-invalid-callback'),
            attemptNumber: 1,
          },
        },
        body: {
          event: 'run.completed',
          work_state: 'completed',
          work_terminal: true,
          callback_ts: 1_700_000_000,
          callback_id: 'raw-producer-invalid-callback',
          attempt_number: 1,
          worker_id: 'worker-1',
          run_id: 'run-producer-invalid',
        },
      }),
    ).rejects.toThrow('glasshive_trace_producer_detail_rejected');
    expect(mockRecordTraceCallback).not.toHaveBeenCalled();
  });

  test.each([
    ['run.failed', 'failed'],
    ['run.cancelled', 'cancelled'],
    ['run.interrupted', 'cancelled'],
  ])(
    'ingests exact producer detail before recording terminal %s evidence',
    async (event, workState) => {
      const detail = {
        workRef: `gh-work-${workState}`,
        runRef: `run-${workState}`,
        state: workState,
      };
      mockRequestAccountApi.mockResolvedValueOnce(detail);
      mockExternalFindOne.mockResolvedValueOnce({
        _id: `work-${workState}`,
        externalState: 'running',
      });
      mockExternalFindOneAndUpdate.mockResolvedValueOnce({
        _id: `work-${workState}`,
        required: true,
        externalState: workState,
      });
      mockExternalFind.mockReturnValue({
        toArray: jest
          .fn()
          .mockResolvedValue([
            { _id: `work-${workState}`, required: true, externalState: workState },
          ]),
      });

      await recordGlassHiveCallbackExternalState({
        binding: {
          originRef: `work-${workState}`,
          workRef: `gh-work-${workState}`,
          ownerId: 'user-1',
          traceIdentity: {
            callbackRef: canonicalCallbackRef(`raw-${event}-callback`),
            attemptNumber: 1,
          },
        },
        body: {
          event,
          work_state: workState,
          work_terminal: true,
          callback_ts: 1_700_000_000,
          callback_id: `raw-${event}-callback`,
          attempt_number: 1,
          worker_id: 'worker-1',
          run_id: `run-${workState}`,
        },
      });

      expect(mockRequestAccountApi).toHaveBeenCalledWith({
        ownerId: 'user-1',
        path: `/v1/work/gh-work-${workState}`,
        timeoutMs: 3000,
      });
      expect(mockRecordGlassHiveWorkDetailTrace).toHaveBeenCalledWith({
        ownerId: 'user-1',
        originRef: `work-${workState}`,
        workRef: `gh-work-${workState}`,
        runRef: `run-${workState}`,
        detail,
      });
      expect(mockRecordGlassHiveWorkDetailTrace.mock.invocationCallOrder[0]).toBeLessThan(
        mockRecordTraceCallback.mock.invocationCallOrder[0],
      );
      expect(mockRecordTraceCallback).toHaveBeenCalledWith(
        expect.objectContaining({ event, workState, workTerminal: true }),
      );
    },
  );

  test('ingests and records an exact pre-runtime Stop callback without an attempt', async () => {
    const detail = {
      workRef: 'gh-work-pre-runtime-stop',
      runRef: 'run-pre-runtime-stop',
      state: 'cancelled',
    };
    mockRequestAccountApi.mockResolvedValueOnce(detail);
    mockExternalFindOne.mockResolvedValueOnce({
      _id: 'work-pre-runtime-stop',
      externalState: 'accepted',
    });
    mockExternalFindOneAndUpdate.mockResolvedValueOnce({
      _id: 'work-pre-runtime-stop',
      required: true,
      externalState: 'cancelled',
    });
    mockExternalFind.mockReturnValue({
      toArray: jest
        .fn()
        .mockResolvedValue([
          { _id: 'work-pre-runtime-stop', required: true, externalState: 'cancelled' },
        ]),
    });

    await recordGlassHiveCallbackExternalState({
      binding: {
        originRef: 'work-pre-runtime-stop',
        workRef: 'gh-work-pre-runtime-stop',
        ownerId: 'user-1',
        traceIdentity: {
          callbackRef: canonicalCallbackRef('raw-pre-runtime-stop-callback'),
          attemptNumber: null,
        },
      },
      body: {
        event: 'run.cancelled',
        work_state: 'cancelled',
        work_terminal: true,
        callback_ts: 1_700_000_000,
        callback_id: 'raw-pre-runtime-stop-callback',
        attempt_number: null,
        worker_id: 'worker-1',
        run_id: 'run-pre-runtime-stop',
      },
    });

    expect(mockRecordGlassHiveWorkDetailTrace).toHaveBeenCalledWith({
      ownerId: 'user-1',
      originRef: 'work-pre-runtime-stop',
      workRef: 'gh-work-pre-runtime-stop',
      runRef: 'run-pre-runtime-stop',
      detail,
    });
    expect(mockRecordGlassHiveWorkDetailTrace.mock.invocationCallOrder[0]).toBeLessThan(
      mockRecordTraceCallback.mock.invocationCallOrder[0],
    );
    expect(mockRecordTraceCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'run.cancelled',
        workState: 'cancelled',
        workTerminal: true,
        attemptNumber: null,
      }),
    );
  });

  test('does not derive a raw callback identity after trusted ingress', async () => {
    mockExternalFindOne.mockResolvedValueOnce({ _id: 'work-raw', externalState: 'accepted' });
    mockExternalFindOneAndUpdate.mockResolvedValueOnce({
      _id: 'work-raw',
      externalState: 'running',
    });

    await recordGlassHiveCallbackExternalState({
      binding: {
        originRef: 'work-raw',
        workRef: 'gh-work-raw',
        ownerId: 'user-1',
      },
      body: {
        event: 'run.started',
        callback_id: 'raw-downstream-callback',
        attempt_number: 1,
        callback_ts: 1_700_000_000,
        worker_id: 'worker-1',
        run_id: 'run-raw',
      },
    });

    expect(mockRecordTraceCallback).not.toHaveBeenCalled();
  });

  test.each([
    ['missing', undefined],
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
  ])(
    'does not record claimable callback evidence for a %s attempt',
    async (_label, attemptNumber) => {
      mockExternalFindOne.mockResolvedValueOnce({ _id: 'work-attempt', externalState: 'accepted' });
      mockExternalFindOneAndUpdate.mockResolvedValueOnce({
        _id: 'work-attempt',
        externalState: 'running',
      });

      await recordGlassHiveCallbackExternalState({
        binding: {
          originRef: 'work-attempt',
          workRef: 'gh-work-attempt',
          ownerId: 'user-1',
        },
        body: {
          event: 'run.started',
          callback_id: 'raw-attempt-callback',
          attempt_number: attemptNumber,
          worker_id: 'worker-1',
          run_id: 'run-attempt',
        },
      });

      expect(mockRecordTraceCallback).not.toHaveBeenCalled();
    },
  );

  test('keeps a WorkRef nonterminal when one run completes while a queued sibling remains', async () => {
    mockExternalFindOne.mockResolvedValueOnce({
      _id: 'work-with-sibling',
      externalState: 'running',
    });
    mockExternalFind.mockReturnValue({
      toArray: jest
        .fn()
        .mockResolvedValue([{ _id: 'work-with-sibling', required: true, externalState: 'queued' }]),
    });

    const result = await recordGlassHiveCallbackExternalState({
      binding: {
        originRef: 'work-with-sibling',
        workRef: 'gh-work-with-sibling',
        ownerId: 'user-1',
        scheduleOccurrenceKey: 'schedule:occurrence-sibling',
      },
      body: {
        event: 'run.completed',
        run_state: 'completed',
        work_state: 'queued',
        work_terminal: false,
        worker_id: 'worker-1',
        run_id: 'run-original',
      },
    });

    expect(mockExternalFindOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: 'work-with-sibling',
        externalState: { $nin: ['completed', 'failed', 'cancelled'] },
      }),
      expect.objectContaining({
        $set: expect.objectContaining({ externalState: 'queued' }),
      }),
      { returnDocument: 'after' },
    );
    expect(result).toEqual(
      expect.objectContaining({
        requiredTerminal: 0,
        allRequiredTerminal: false,
        state: 'waiting_external',
      }),
    );
  });

  test('fails terminal run callbacks without the authoritative work lifecycle contract nonterminal', async () => {
    mockExternalFindOne.mockResolvedValueOnce({
      _id: 'legacy-work',
      externalState: 'running',
    });

    await recordGlassHiveCallbackExternalState({
      binding: {
        originRef: 'legacy-work',
        workRef: 'gh-legacy-work',
        ownerId: 'user-1',
      },
      body: {
        event: 'run.completed',
        worker_id: 'worker-legacy',
        run_id: 'run-legacy',
      },
    });

    expect(mockExternalFindOneAndUpdate).not.toHaveBeenCalled();
  });

  test('summarizes a scheduler occurrence as waiting while any required mission is active', async () => {
    mockExternalFind.mockReturnValue({
      toArray: jest.fn().mockResolvedValue([
        { _id: 'work-1', required: true, externalState: 'running' },
        { _id: 'work-2', required: true, externalState: 'completed' },
      ]),
    });

    await expect(
      getSchedulerExternalWorkSummary({
        ownerId: 'user-1',
        schedulerDispatchDocumentId: 'dispatch-doc-1',
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        requiredTotal: 2,
        requiredTerminal: 1,
        allRequiredTerminal: false,
        state: 'waiting_external',
      }),
    );
  });

  test('keeps structured host-capacity callbacks nonterminal', async () => {
    mockExternalFindOne.mockResolvedValueOnce({
      _id: 'work-capacity',
      workRef: 'gh-work-capacity',
      externalState: 'accepted',
    });
    mockExternalFind.mockReturnValue({
      toArray: jest
        .fn()
        .mockResolvedValue([{ _id: 'work-capacity', required: true, externalState: 'queued' }]),
    });

    const result = await recordGlassHiveCallbackExternalState({
      binding: {
        originRef: 'work-capacity',
        workRef: 'gh-work-capacity',
        ownerId: 'user-1',
        conversationId: 'conversation-1',
        anchorMessageId: 'assistant-anchor',
        scheduleOccurrenceKey: 'schedule:occurrence-capacity',
      },
      body: {
        event: 'run.failed',
        failure_code: 'host_worker_already_active',
        run_id: 'run-capacity',
      },
    });

    expect(mockExternalFindOneAndUpdate.mock.calls[0][1].$set.externalState).toBe('queued');
    expect(result).toEqual(
      expect.objectContaining({ state: 'waiting_external', allRequiredTerminal: false }),
    );
  });

  test.each([
    ['run.started', 'running', false],
    ['run.paused', 'paused', false],
    ['run.needs_input', 'needs_input', true],
    ['run.requeued', 'queued', false],
    ['run.capacity_waiting', 'queued', false],
    ['run.waiting_on_capacity', 'queued', false],
    ['run.stopping', 'stopping', false],
  ])('projects %s into canonical %s work truth', async (event, expectedState, attentionPending) => {
    mockExternalFindOne.mockResolvedValueOnce({
      _id: 'work-lifecycle',
      workRef: 'gh-work-lifecycle',
      externalState: 'accepted',
    });
    mockExternalFindOneAndUpdate.mockResolvedValueOnce({
      _id: 'work-lifecycle',
      externalState: expectedState,
    });

    await recordGlassHiveCallbackExternalState({
      binding: {
        originRef: 'work-lifecycle',
        workRef: 'gh-work-lifecycle',
        ownerId: 'user-1',
        conversationId: 'conversation-1',
        anchorMessageId: 'assistant-anchor',
      },
      body: { event, worker_id: 'worker-1', run_id: 'run-1' },
    });

    expect(mockExternalFindOneAndUpdate.mock.calls[0][1].$set).toEqual(
      expect.objectContaining({ externalState: expectedState, attentionPending }),
    );
  });

  test('keeps an unresolved terminal surface visible after adjudication bookkeeping', async () => {
    mockExternalFindOneAndUpdate.mockResolvedValue({
      _id: 'work-unresolved',
      deliveryState: 'unresolved',
      attentionPending: true,
    });

    await recordGlassHiveSurfaceDeliveryOutcome({
      originRef: 'work-unresolved',
      state: 'unresolved',
    });
    expect(mockExternalFindOneAndUpdate.mock.calls[0][1].$set).toEqual(
      expect.objectContaining({ deliveryState: 'unresolved', attentionPending: true }),
    );

    await recordGlassHiveAdjudicationOutcome({
      originRef: 'work-unresolved',
      state: 'failed',
      followUpMessageId: 'follow-up-1',
      errorCode: 'mission_surface_delivery_unresolved',
    });
    expect(mockExternalFindOneAndUpdate.mock.calls[1][1].$set).toEqual(
      expect.objectContaining({ deliveryState: 'unresolved', attentionPending: true }),
    );
  });

  test('preserves an ambiguous terminal transport outcome as unknown', async () => {
    mockExternalFindOneAndUpdate.mockResolvedValueOnce({
      _id: 'work-unknown',
      deliveryState: 'unknown',
      attentionPending: true,
    });

    await expect(
      recordGlassHiveSurfaceDeliveryOutcome({
        originRef: 'work-unknown',
        state: 'unknown',
      }),
    ).resolves.toEqual(expect.objectContaining({ deliveryState: 'unknown' }));
    expect(mockExternalFindOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'work-unknown' },
      expect.objectContaining({
        $set: expect.objectContaining({ deliveryState: 'unknown', attentionPending: true }),
      }),
      expect.any(Object),
    );
  });

  test.each([
    ['sent', false],
    ['unknown', true],
    ['unresolved', true],
  ])(
    'does not replace %s delivery truth when a terminal callback is replayed',
    async (deliveryState, attentionPending) => {
      mockExternalFindOne.mockResolvedValueOnce({
        _id: 'work-terminal-replay',
        externalState: 'completed',
        deliveryState,
        attentionPending,
      });
      mockExternalFindOneAndUpdate.mockResolvedValueOnce({
        _id: 'work-terminal-replay',
        externalState: 'completed',
        deliveryState,
        attentionPending,
      });

      await recordGlassHiveCallbackExternalState({
        binding: {
          originRef: 'work-terminal-replay',
          workRef: 'gh-work-terminal-replay',
          ownerId: 'owner-replay',
        },
        body: {
          event: 'run.completed',
          work_state: 'completed',
          work_terminal: true,
          worker_id: 'worker-replay',
          run_id: 'run-replay',
        },
      });

      const update = mockExternalFindOneAndUpdate.mock.calls[0][1].$set;
      expect(update).not.toHaveProperty('deliveryState');
      expect(update).not.toHaveProperty('attentionPending');
      expect(update).not.toHaveProperty('externalState');
    },
  );

  test.each([
    ['sent', false],
    ['unknown', true],
  ])(
    'preserves an existing %s delivery when authoritative work first becomes terminal',
    async (deliveryState, attentionPending) => {
      mockExternalFindOne.mockResolvedValueOnce({
        _id: 'work-terminal-first',
        externalState: 'running',
        deliveryState,
        attentionPending,
      });
      mockExternalFindOneAndUpdate.mockResolvedValueOnce({
        _id: 'work-terminal-first',
        externalState: 'completed',
        deliveryState,
        attentionPending,
      });

      await recordGlassHiveCallbackExternalState({
        binding: {
          originRef: 'work-terminal-first',
          workRef: 'gh-work-terminal-first',
          ownerId: 'owner-first',
        },
        body: {
          event: 'run.completed',
          work_state: 'completed',
          work_terminal: true,
          worker_id: 'worker-first',
          run_id: 'run-first',
        },
      });

      const update = mockExternalFindOneAndUpdate.mock.calls[0][1].$set;
      expect(update.externalState).toBe('completed');
      expect(update).not.toHaveProperty('deliveryState');
      expect(update.attentionPending).toBe(attentionPending);
    },
  );

  test('prevents a stale enqueued projection from overwriting unknown delivery truth', async () => {
    const stored = {
      _id: 'work-stale-delivery',
      deliveryState: 'unknown',
      attentionPending: true,
    };
    mockExternalFindOneAndUpdate.mockImplementation(async (filter, update) => {
      if (filter?.deliveryState?.$nin?.includes(stored.deliveryState)) {
        return { value: null };
      }
      Object.assign(stored, update?.$set || {});
      return { value: { ...stored } };
    });

    await recordGlassHiveSurfaceDeliveryOutcome({
      originRef: 'work-stale-delivery',
      state: 'enqueued',
    });

    expect(stored.deliveryState).toBe('unknown');
    expect(stored.attentionPending).toBe(true);
  });

  test('does not turn unknown transport back into enqueued after completed adjudication', async () => {
    const stored = {
      _id: 'work-unknown-adjudication',
      deliveryState: 'unknown',
      attentionPending: true,
    };
    mockExternalFindOneAndUpdate.mockImplementation(async (filter, update) => {
      const excluded = filter?.deliveryState?.$nin;
      if (Array.isArray(excluded) && excluded.includes(stored.deliveryState)) {
        return { value: null };
      }
      Object.assign(stored, update?.$set || {});
      return { value: { ...stored } };
    });

    await recordGlassHiveAdjudicationOutcome({
      originRef: 'work-unknown-adjudication',
      state: 'completed',
      followUpMessageId: 'follow-up-unknown',
    });

    expect(stored.deliveryState).toBe('unknown');
    expect(stored.attentionPending).toBe(true);
  });

  test('terminal adjudication never regresses an already-sent web delivery to enqueued', async () => {
    const stored = {
      _id: 'work-web-sent',
      deliveryState: 'sent',
      attentionPending: false,
    };
    mockExternalFindOneAndUpdate.mockImplementation(async (filter, update) => {
      const excluded = filter?.deliveryState?.$nin;
      if (Array.isArray(excluded) && excluded.includes(stored.deliveryState)) {
        return { value: null };
      }
      Object.assign(stored, update?.$set || {});
      return { value: { ...stored } };
    });

    const result = await recordGlassHiveAdjudicationOutcome({
      originRef: 'work-web-sent',
      state: 'completed',
      followUpMessageId: 'follow-up-web',
    });

    expect(stored.deliveryState).toBe('sent');
    expect(stored.attentionPending).toBe(false);
    expect(result).toEqual(expect.objectContaining({ deliveryState: 'sent' }));
  });

  test('detects only active or attention-bearing owner work for focused-mode roster awareness', async () => {
    mockExternalFindOne.mockResolvedValueOnce({ _id: 'work-active' }).mockResolvedValueOnce(null);

    await expect(hasKnownExternalWork({ ownerId: 'user-1' })).resolves.toBe(true);
    expect(mockExternalFindOne.mock.calls[0]).toEqual([
      {
        ownerId: 'user-1',
        $or: [
          {
            launchState: 'not_dispatched',
            externalState: 'failed',
            attentionPending: { $ne: false },
          },
          {
            launchState: { $nin: ['prepared', 'not_dispatched'] },
            $or: [
              { externalState: { $nin: ['completed', 'failed', 'cancelled'] } },
              { attentionPending: true },
              {
                deliveryState: {
                  $in: ['pending', 'enqueued', 'failed', 'unresolved', 'unknown'],
                },
              },
            ],
          },
        ],
      },
      { projection: { _id: 1 } },
    ]);

    await expect(hasKnownExternalWork({ ownerId: '' })).resolves.toBe(false);
    expect(mockExternalFindOne).toHaveBeenCalledTimes(1);
  });
});
