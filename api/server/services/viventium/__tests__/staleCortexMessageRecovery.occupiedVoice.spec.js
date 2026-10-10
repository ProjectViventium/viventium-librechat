jest.mock('~/db/models', () => ({
  ViventiumCortexInsightDelivery: {},
  Message: {},
  Conversation: {},
}));
jest.mock('../CortexInsightOutboxService', () => ({
  replayCompletedCortexInsightOutbox: jest.fn(),
}));
const {
  resolveOwnedVoiceCortexRecovery,
  recoverPendingCortexInsightDeliveries,
} = require('../staleCortexMessageRecovery');
const cause = { status: 409, code: 'conversation_session_authority_conflict' };
const parent = {
  ownerId: 'owner-a',
  conversationId: 'conversation-a',
  parentMessageId: 'parent-a',
  surface: 'voice',
};
const parentState = () => ({
  messageId: 'parent-a',
  unfinished: false,
  metadata: {
    viventium: {
      callSessionId: 'call-a',
      voiceTaskId: 'task-a',
      interactionContext: {
        conversation_id: 'conversation-a',
        logical_turn_id: 'turn-a',
        revision: 2,
        source_event_id: 'source-a',
      },
      cortexFollowUpDecision: { generationFailed: true, generationFailure: cause },
    },
  },
});
const context = { streamId: 'stream-a', messageRevision: 2 };
const task = {
  taskId: 'task-a',
  userId: 'owner-a',
  callSessionId: 'call-a',
  conversationId: 'conversation-a',
  streamId: 'stream-a',
};
const call = {
  callSessionId: 'call-a',
  userId: 'owner-a',
  conversationId: 'conversation-a',
  mode: 'call',
  status: 'listening',
};
function authority(changes = {}) {
  return {
    hydrateVoiceTask: jest.fn(async () => task),
    hydrateVoiceTaskByStreamId: jest.fn(async () => task),
    getVoiceTaskTraceBinding: jest.fn(() => ({ ...task, logicalTurnId: 'turn-a' })),
    snapshotEvent: jest.fn(() => ({ resultMessageId: 'parent-a' })),
    isVoiceTaskSuppressedDurably: jest.fn(async () => false),
    getCallSession: jest.fn(async () => call),
    getActiveCallSessionForConversation: jest.fn(async () => call),
    getJob: jest.fn(async () => null),
    ...changes,
  };
}
describe('owned typed-occupancy Voice recovery', () => {
  const resolve = (changes = {}, state = parentState(), recoveryContext = context) =>
    resolveOwnedVoiceCortexRecovery({
      ...parent,
      parentState: state,
      recoveryContext,
      dependencies: authority(changes),
    });
  test('restores only exact original leased Call/task/source/revision', async () => {
    const deps = authority();
    expect(
      await resolveOwnedVoiceCortexRecovery({
        ...parent,
        parentState: parentState(),
        recoveryContext: context,
        dependencies: deps,
      }),
    ).toMatchObject({
      state: 'live',
      callSessionId: 'call-a',
      taskId: 'task-a',
      streamId: 'stream-a',
    });
    expect(deps.hydrateVoiceTaskByStreamId).toHaveBeenCalledWith('stream-a', {
      callSessionId: 'call-a',
      userId: 'owner-a',
      requireDurable: true,
    });
  });
  test.each([
    ['owner', { hydrateVoiceTask: jest.fn(async () => ({ ...task, userId: 'other' })) }],
    [
      'stream',
      {
        getVoiceTaskTraceBinding: jest.fn(() => ({
          ...task,
          streamId: 'other',
          logicalTurnId: 'turn-a',
        })),
      },
    ],
    ['turn', { getVoiceTaskTraceBinding: jest.fn(() => ({ ...task, logicalTurnId: 'other' })) }],
    ['result', { snapshotEvent: jest.fn(() => ({ resultMessageId: 'other' })) }],
  ])('foreign %s cannot author or speak', async (_name, changes) => {
    await expect(resolve(changes)).rejects.toMatchObject({
      code: 'cortex_voice_recovery_scope_mismatch',
    });
  });
  test('stale source revision fails closed', async () => {
    await expect(
      resolve({}, parentState(), { ...context, messageRevision: 3 }),
    ).rejects.toMatchObject({ code: 'cortex_voice_recovery_scope_mismatch' });
  });
  test('the existing superseded generator revision is terminal, not a fresh author', async () => {
    expect(
      await resolve({
        getJob: jest.fn(async () => ({
          status: 'superseded',
          metadata: {
            userId: 'owner-a',
            conversationId: 'conversation-a',
            responseMessageId: 'parent-a',
            viventiumVoiceTaskId: 'task-a',
            viventiumCallSessionId: 'call-a',
            interactionContext: parentState().metadata.viventium.interactionContext,
          },
        })),
      }),
    ).toMatchObject({ state: 'suppressed', dropReason: 'conversation_moved_on' });
  });
  test('a reused stream cannot borrow another generator owner', async () => {
    await expect(
      resolve({ getJob: jest.fn(async () => ({ metadata: { userId: 'other' } })) }),
    ).rejects.toMatchObject({ code: 'cortex_voice_recovery_scope_mismatch' });
  });
  test('Stop suppresses before Call authority is read', async () => {
    const deps = authority({ isVoiceTaskSuppressedDurably: jest.fn(async () => true) });
    expect(
      await resolveOwnedVoiceCortexRecovery({
        ...parent,
        parentState: parentState(),
        recoveryContext: context,
        dependencies: deps,
      }),
    ).toMatchObject({ state: 'suppressed' });
    expect(deps.getCallSession).not.toHaveBeenCalled();
  });
  test.each([
    [
      'ended',
      {
        getCallSession: jest.fn(async () => ({ ...call, status: 'ended' })),
        getActiveCallSessionForConversation: jest.fn(async () => null),
      },
    ],
    [
      'expired',
      {
        getCallSession: jest.fn(async () => null),
        getActiveCallSessionForConversation: jest.fn(async () => null),
      },
    ],
  ])('%s keeps linked text without granting speech', async (_name, changes) => {
    const result = await resolve(changes);
    expect(result).toMatchObject({
      state: 'linked_text',
      callSessionId: 'call-a',
      taskId: 'task-a',
    });
    expect(result.session).toBeUndefined();
  });
  test.each([
    ['temporary lease gap', null],
    ['another active Call', { ...call, callSessionId: 'other' }],
  ])(
    '%s waits for the original unended Call instead of dropping its Voice obligation',
    async (_name, active) => {
      const result = await resolve({
        getActiveCallSessionForConversation: jest.fn(async () => active),
      });
      expect(result).toMatchObject({ state: 'waiting', callSessionId: 'call-a' });
      expect(result.session).toBeUndefined();
    },
  );
});
function fixture({ state = 'live', persisted = false, skip = false } = {}) {
  const claim = {
    deliveryId: 'delivery-a',
    claimToken: 'claim-a',
    claimGeneration: 1,
    attemptNumber: 2,
    requiredSurfaces: ['voice'],
    presentedSurfaces: [],
    persistenceStatus: persisted ? 'persisted' : 'pending',
    ...(persisted ? { persistedMessageId: 'child-a' } : {}),
  };
  const service = {
    listRecoverableParents: jest.fn(async () => [parent]),
    listByParent: jest.fn(async () => [claim]),
    listEvents: jest.fn(async () => [
      { deliveryId: claim.deliveryId, transition: 'failure', reason: 'native_session_occupied' },
    ]),
    deferRecoverableParent: jest.fn(async () => ({ deferred: 1 })),
    claimPendingByParent: jest.fn(async () => ({
      claimId: 'claim-a',
      deliveries: [claim],
      claimed: [claim],
      recoveryContext: context,
      insights: [{ cortexId: 'cortex-a', insight: 'Useful insight.', status: 'completed' }],
    })),
    markPersisted: jest.fn(async () => [claim]),
    markDropped: jest.fn(async () => [{ ...claim, status: 'dropped' }]),
    markFailed: jest.fn(async () => [claim]),
  };
  const message = {
    messageId: 'child-a',
    revision: 2,
    metadata: {
      viventium: {
        deliveryDisposition: { version: 1, audio: skip ? 'skip' : 'eligible' },
      },
    },
  };
  const options = {
    deliveryService: service,
    replayMessageFallbacks: jest.fn(),
    replayOutbox: jest.fn(),
    loadParentState: jest.fn(async () => parentState()),
    hasDurableTelegramDispatchAuthority: jest.fn(async () => false),
    resolveVoiceRecovery: jest.fn(async () => ({
      state,
      callSessionId: 'call-a',
      taskId: 'task-a',
      streamId: 'stream-a',
    })),
    createMessage: jest.fn(async () => message),
    loadMessage: jest.fn(async () => message),
    bindMessageGeneration: jest.fn(async ({ message: value }) => value),
    presentSurface: jest.fn(),
    wakeVoiceFollowUp: jest.fn(async () => true),
  };
  return { service, options };
}
describe('existing durable occupancy consumer', () => {
  test('immutable per-row occupancy survives overwritten parent decisions', async () => {
    const { service, options } = fixture();
    const overwritten = parentState();
    overwritten.metadata.viventium.cortexFollowUpDecision = { generationFailed: true };
    options.loadParentState.mockResolvedValue(overwritten);
    expect(await recoverPendingCortexInsightDeliveries(options)).toMatchObject({
      persisted: 1,
      pending: 1,
      dropped: 0,
    });
    expect(options.createMessage).toHaveBeenCalledTimes(1);
    expect(service.markDropped).not.toHaveBeenCalled();
  });
  test('parent marker cannot widen an unrelated row without ledger occupancy evidence', async () => {
    const { service, options } = fixture();
    service.listEvents.mockResolvedValue([
      { deliveryId: 'delivery-a', transition: 'failure', reason: 'presentation_failed' },
    ]);
    await recoverPendingCortexInsightDeliveries(options);
    expect(options.resolveVoiceRecovery).not.toHaveBeenCalled();
    expect(options.createMessage).not.toHaveBeenCalled();
    expect(service.markDropped).toHaveBeenCalledWith(
      expect.objectContaining({ dropReason: 'unsupported_surface' }),
    );
  });
  test('mixed per-row cause preserves typed contribution without widening or slicing its complete batch', async () => {
    const { service, options } = fixture();
    const original = (await service.listByParent())[0];
    service.listByParent.mockResolvedValue([
      original,
      { ...original, deliveryId: 'delivery-unrelated' },
    ]);
    service.listEvents.mockResolvedValue([
      { deliveryId: 'delivery-a', transition: 'failure', reason: 'native_session_occupied' },
      { deliveryId: 'delivery-unrelated', transition: 'failure', reason: 'presentation_failed' },
    ]);
    expect(await recoverPendingCortexInsightDeliveries(options)).toMatchObject({
      pending: 2,
      dropped: 0,
    });
    expect(service.claimPendingByParent).not.toHaveBeenCalled();
    expect(service.markDropped).not.toHaveBeenCalled();
    expect(options.createMessage).not.toHaveBeenCalled();
    expect(service.deferRecoverableParent).toHaveBeenCalledTimes(1);
  });
  test('saved live child re-wakes and backs off without reclaiming presentation', async () => {
    const { service, options } = fixture({ persisted: true });
    await recoverPendingCortexInsightDeliveries(options);
    expect(options.wakeVoiceFollowUp).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: 'owner-a',
        callSessionId: 'call-a',
        voiceTaskId: 'task-a',
        conversationId: 'conversation-a',
        parentMessageId: 'parent-a',
        messageId: 'child-a',
      }),
    );
    expect(service.deferRecoverableParent).toHaveBeenCalledTimes(1);
    expect(service.claimPendingByParent).not.toHaveBeenCalled();
    expect(options.bindMessageGeneration).not.toHaveBeenCalled();
  });
  test('failed saved-child wake still defers and preserves its claim generation', async () => {
    const { service, options } = fixture({ persisted: true });
    options.wakeVoiceFollowUp.mockRejectedValue(new Error('Synthetic task store unavailable'));
    expect(await recoverPendingCortexInsightDeliveries(options)).toMatchObject({ pending: 1 });
    expect(service.deferRecoverableParent).toHaveBeenCalledTimes(1);
    expect(service.claimPendingByParent).not.toHaveBeenCalled();
  });
  test.each([2, 3])(
    'permanent scope mismatch spends bounded existing attempt %s without authoring',
    async (attemptNumber) => {
      const { service, options } = fixture();
      (await service.claimPendingByParent()).claimed[0].attemptNumber = attemptNumber;
      service.claimPendingByParent.mockClear();
      options.resolveVoiceRecovery.mockRejectedValue(
        Object.assign(new Error('Synthetic foreign source'), {
          code: 'cortex_voice_recovery_scope_mismatch',
        }),
      );
      const result = await recoverPendingCortexInsightDeliveries(options);
      expect(service.claimPendingByParent).toHaveBeenCalledTimes(1);
      expect(options.createMessage).not.toHaveBeenCalled();
      if (attemptNumber === 3) {
        expect(result.dropped).toBe(1);
        expect(service.markDropped).toHaveBeenCalledWith(
          expect.objectContaining({ dropReason: 'delivery_attempts_exhausted' }),
        );
      } else expect(service.markFailed).toHaveBeenCalledTimes(1);
    },
  );

  test('persists once; real Voice receiver alone may confirm playout', async () => {
    const { service, options } = fixture();
    expect(await recoverPendingCortexInsightDeliveries(options)).toMatchObject({
      persisted: 1,
      pending: 1,
      sent: 0,
    });
    expect(options.createMessage).toHaveBeenCalledTimes(1);
    expect(service.markPersisted).toHaveBeenCalledTimes(1);
    expect(service.markDropped).not.toHaveBeenCalled();
    expect(options.presentSurface).not.toHaveBeenCalled();
  });
  test('restart with persisted child never reclaims or re-authors it', async () => {
    const { service, options } = fixture({ persisted: true });
    expect(await recoverPendingCortexInsightDeliveries(options)).toMatchObject({
      pending: 1,
      sent: 0,
    });
    expect(service.claimPendingByParent).not.toHaveBeenCalled();
    expect(options.createMessage).not.toHaveBeenCalled();
  });
  test.each([false, true])(
    'unended gateway lease gap keeps persisted=%s pending without spending a claim',
    async (persisted) => {
      const { service, options } = fixture({ state: 'waiting', persisted });
      expect(await recoverPendingCortexInsightDeliveries(options)).toMatchObject({
        pending: 1,
        dropped: 0,
      });
      expect(service.claimPendingByParent).not.toHaveBeenCalled();
      expect(options.createMessage).not.toHaveBeenCalled();
      expect(service.markDropped).not.toHaveBeenCalled();
    },
  );
  test('lease lost during authoring retains its saved result pending for same-Call reclaim', async () => {
    const { service, options } = fixture();
    options.resolveVoiceRecovery
      .mockResolvedValueOnce({ state: 'live' })
      .mockResolvedValueOnce({ state: 'live' })
      .mockResolvedValue({ state: 'waiting' });
    expect(await recoverPendingCortexInsightDeliveries(options)).toMatchObject({
      persisted: 1,
      pending: 1,
      dropped: 0,
    });
    expect(options.createMessage).toHaveBeenCalledTimes(1);
    expect(service.markDropped).not.toHaveBeenCalled();
  });
  test('lease lost after claim defers before authoring even on the final attempt', async () => {
    const { service, options } = fixture();
    (await service.claimPendingByParent()).claimed[0].attemptNumber = 3;
    service.claimPendingByParent.mockClear();
    options.resolveVoiceRecovery
      .mockResolvedValueOnce({ state: 'live' })
      .mockResolvedValue({ state: 'waiting' });
    expect(await recoverPendingCortexInsightDeliveries(options)).toMatchObject({
      pending: 1,
      dropped: 0,
    });
    expect(options.createMessage).not.toHaveBeenCalled();
    expect(service.markFailed).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'presentation_failed' }),
    );
    expect(service.markDropped).not.toHaveBeenCalled();
  });
  test('a pending-authority settlement failure stays isolated, not fatal to recovery', async () => {
    const { service, options } = fixture();
    options.createMessage.mockRejectedValue(
      Object.assign(new Error('Temporary lease gap'), {
        code: 'cortex_voice_recovery_authority_pending',
      }),
    );
    service.markFailed.mockRejectedValue(new Error('Temporary store unavailable'));
    await expect(recoverPendingCortexInsightDeliveries(options)).resolves.toMatchObject({
      pending: 1,
      dropped: 0,
      failed: 1,
    });
  });
  test.each([
    ['linked_text', 'unsupported_surface'],
    ['suppressed', 'voice_task_suppressed'],
  ])('%s closes the exact Voice obligation', async (state, reason) => {
    const { service, options } = fixture({ state });
    expect(await recoverPendingCortexInsightDeliveries(options)).toMatchObject({
      dropped: 1,
      sent: 0,
    });
    expect(service.markDropped).toHaveBeenCalledWith(
      expect.objectContaining({ dropReason: reason }),
    );
    expect(options.createMessage).toHaveBeenCalledTimes(state === 'linked_text' ? 1 : 0);
    expect(service.markPersisted).toHaveBeenCalledTimes(state === 'linked_text' ? 1 : 0);
  });
  test('model audio skip keeps text and settles semantic suppression', async () => {
    const { service, options } = fixture({ skip: true });
    await recoverPendingCortexInsightDeliveries(options);
    expect(service.markPersisted).toHaveBeenCalledTimes(1);
    expect(service.markDropped).toHaveBeenCalledWith(
      expect.objectContaining({ dropReason: 'semantic_suppression' }),
    );
    expect(options.presentSurface).not.toHaveBeenCalled();
  });
  test('crash after saving model skip settles it without a second author', async () => {
    const { service, options } = fixture({ persisted: true, skip: true });
    expect(await recoverPendingCortexInsightDeliveries(options)).toMatchObject({
      dropped: 1,
      sent: 0,
    });
    expect(options.createMessage).not.toHaveBeenCalled();
    expect(service.markDropped).toHaveBeenCalledWith(
      expect.objectContaining({ dropReason: 'semantic_suppression' }),
    );
  });
  test('a genuine NTA terminal receipt is counted without a new failure/retry', async () => {
    const { service, options } = fixture();
    options.createMessage.mockResolvedValue(null);
    const claim = (await service.listByParent())[0];
    service.listByParent
      .mockResolvedValueOnce([claim])
      .mockResolvedValueOnce([{ ...claim, status: 'dropped', dropReason: 'semantic_suppression' }]);
    expect(await recoverPendingCortexInsightDeliveries(options)).toMatchObject({
      dropped: 1,
      pending: 0,
    });
    expect(service.markFailed).not.toHaveBeenCalled();
  });
  test('untyped Voice failure keeps its existing unsupported contract', async () => {
    const { service, options } = fixture();
    options.loadParentState.mockResolvedValue({ messageId: 'parent-a', unfinished: false });
    service.listEvents.mockResolvedValue([]);
    await recoverPendingCortexInsightDeliveries(options);
    expect(service.markDropped).toHaveBeenCalledWith(
      expect.objectContaining({ dropReason: 'unsupported_surface' }),
    );
    expect(options.resolveVoiceRecovery).not.toHaveBeenCalled();
    expect(options.createMessage).not.toHaveBeenCalled();
  });
});
