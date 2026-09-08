const { logger } = require('@librechat/data-schemas');
const { createCortexFollowUpMessage, settleSuppressedCortexInsightDeliveries,
  buildFollowUpDecisionRecord, persistCortexFollowUpMessageWithLedger,
  resolveCortexInsightDropReason } = require('../BackgroundCortexFollowUpService');
function pinnedFeelingSnapshot(overrides = {}) {
  return {
    available: true,
    enabled: true,
    agentScope: 'all_agents',
    version: 41,
    asOf: '2026-08-22T12:00:00.000Z',
    capsule: 'Synthetic request-pinned Feelings capsule.',
    snapshotHash: 'a'.repeat(64),
    rangePromptOverrideCount: 3,
    activeRangePromptOverrideCount: 2,
    activeRangePromptOverrideChars: 120,
    ...overrides,
  };
}

function exactPhaseAClaim(expectedSnapshot) {
  return jest.fn(async (request) => {
    if (JSON.stringify(request.feelingSnapshot || null) !== JSON.stringify(expectedSnapshot)) {
      const error = new Error('Cortex insight delivery envelope conflict');
      error.code = 'cortex_insight_delivery_envelope_conflict';
      throw error;
    }
    return { claimId: 'claim-phase-a', deliveries: [], claimed: [] };
  });
}

describe('createCortexFollowUpMessage request-pinned delivery envelope', () => {
  const baseRequest = (feelingSnapshot) => ({
    user: { id: 'owner-phase-a' },
    body: {
      streamId: 'stream-phase-a',
      viventiumLogicalTurnRevision: 2,
      viventiumSurface: 'web',
    },
    headers: { 'x-viventium-surface': 'web' },
    ...(feelingSnapshot ? { _viventiumFeelingSnapshot: feelingSnapshot } : {}),
  });

  const invoke = ({ feelingSnapshot, claimBatch, deliveryParentMessageId }) =>
    createCortexFollowUpMessage({
      req: baseRequest(feelingSnapshot),
      conversationId: 'conversation-phase-a',
      parentMessageId: 'parent-phase-a',
      ...(deliveryParentMessageId ? { deliveryParentMessageId } : {}),
      agent: { id: 'agent-phase-a' },
      insightsData: { insights: [{ cortexId: 'memory', insight: 'Pinned result.' }] },
      recentResponse: 'Primary answer.',
      dependencies: { claimBatch },
    });

  test('claims an existing Phase-A envelope with the identical pinned snapshot', async () => {
    const expectedSnapshot = pinnedFeelingSnapshot();
    const claimBatch = exactPhaseAClaim(expectedSnapshot);

    await expect(invoke({ feelingSnapshot: expectedSnapshot, claimBatch })).resolves.toBeNull();
    expect(claimBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: 'owner-phase-a',
        conversationId: 'conversation-phase-a',
        parentMessageId: 'parent-phase-a',
        feelingSnapshot: expectedSnapshot,
      }),
    );
  });

  test('uses a separate delivery parent only for the exact claim', async () => {
    const expectedSnapshot = pinnedFeelingSnapshot();
    const claimBatch = exactPhaseAClaim(expectedSnapshot);

    await expect(
      invoke({
        feelingSnapshot: expectedSnapshot,
        claimBatch,
        deliveryParentMessageId: 'delivery-parent-phase-a',
      }),
    ).resolves.toBeNull();
    expect(claimBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: 'owner-phase-a',
        conversationId: 'conversation-phase-a',
        parentMessageId: 'delivery-parent-phase-a',
        feelingSnapshot: expectedSnapshot,
      }),
    );
    expect(claimBatch.mock.calls[0][0]).not.toHaveProperty('semanticParentMessageId');
  });

  test.each([
    ['omitted', null],
    [
      'changed',
      pinnedFeelingSnapshot({
        capsule: 'Changed request-pinned Feelings capsule.',
        snapshotHash: 'b'.repeat(64),
      }),
    ],
  ])(
    'rejects a %s Phase-B snapshot against the existing Phase-A envelope',
    async (_label, value) => {
      const claimBatch = exactPhaseAClaim(pinnedFeelingSnapshot());
      await expect(invoke({ feelingSnapshot: value, claimBatch })).rejects.toMatchObject({
        code: 'cortex_insight_delivery_envelope_conflict',
      });
    },
  );
});

describe('settleSuppressedCortexInsightDeliveries', () => {
  test('claims and terminally drops the exact suppressed insight batch', async () => {
    const feelingSnapshot = {
      available: true,
      enabled: false,
      agentScope: 'all_agents',
      version: 0,
      asOf: '2026-08-26T06:18:51.417Z',
      capsule: '',
      snapshotHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      rangePromptOverrideCount: 0,
      activeRangePromptOverrideCount: 0,
      activeRangePromptOverrideChars: 0,
    };
    const claim = {
      deliveryId: 'delivery-1',
      claimToken: 'claim-token-1',
      claimGeneration: 2,
      attemptNumber: 1,
    };
    const claimBatch = jest.fn().mockResolvedValue({ claimed: [claim] });
    const markDropped = jest
      .fn()
      .mockResolvedValue([{ deliveryId: 'delivery-1', claimGeneration: 2, status: 'dropped' }]);
    const requireExactSettlement = jest.fn();

    await expect(
      settleSuppressedCortexInsightDeliveries({
        req: {
          user: { id: 'owner-1' },
          body: { streamId: 'stream-1', viventiumLogicalTurnRevision: 3 },
          _viventiumFeelingSnapshot: feelingSnapshot,
        },
        conversationId: 'conversation-1',
        parentMessageId: 'parent-1',
        insightsData: {
          insights: [{ cortexId: 'memory', insight: 'Suppressed evidence.' }],
        },
        dropReason: 'semantic_suppression',
        dependencies: { claimBatch, markDropped, requireExactSettlement },
      }),
    ).resolves.toEqual({
      claimed: 1,
      dropped: 1,
      dropReason: 'semantic_suppression',
    });
    expect(claimBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: 'owner-1',
        conversationId: 'conversation-1',
        parentMessageId: 'parent-1',
        streamId: 'stream-1',
        messageRevision: 3,
        feelingSnapshot,
      }),
    );
    expect(markDropped).toHaveBeenCalledWith({
      ownerId: 'owner-1',
      claims: [claim],
      dropReason: 'semantic_suppression',
    });
    expect(requireExactSettlement).toHaveBeenCalledWith(
      [claim],
      [{ deliveryId: 'delivery-1', claimGeneration: 2, status: 'dropped' }],
    );
  });

  test('does not touch the ledger when suppression carries no insight', async () => {
    const claimBatch = jest.fn();
    await expect(
      settleSuppressedCortexInsightDeliveries({
        req: { user: { id: 'owner-1' }, body: {} },
        conversationId: 'conversation-1',
        parentMessageId: 'parent-1',
        insightsData: { insights: [] },
        dropReason: 'semantic_suppression',
        dependencies: { claimBatch },
      }),
    ).resolves.toEqual({ claimed: 0, dropped: 0, dropReason: 'semantic_suppression' });
    expect(claimBatch).not.toHaveBeenCalled();
  });
});

describe('saved exact delivery settlement', () => {
  test('does not claim durable persistence before the message save succeeds', () => {
    const record = buildFollowUpDecisionRecord({
      req: { body: { viventiumSurface: 'web' } },
      conversationId: 'conv-1',
      parentMessageId: 'parent-1',
      insightsData: {
        insights: [{ cortexName: 'Emotional Resonance', insight: 'A useful result.' }],
      },
      finalText: 'A useful result.',
      decision: {
        selectedStrategy: 'llm_generated',
        suppressionReason: '',
        llmResult: 'visible',
      },
    });

    expect(record.result).toBe('pending');
  });

  test('records message persistence without claiming surface delivery was sent', async () => {
    let saveCompleted = false;
    const saveMessage = jest.fn(async () => {
      saveCompleted = true;
      return { messageId: 'follow-up-1' };
    });
    const markPersisted = jest.fn(async () => {
      expect(saveCompleted).toBe(true);
      return [{ deliveryId: 'delivery-1', claimGeneration: 1 }];
    });
    const markDropped = jest.fn();
    const persistDecision = jest.fn();
    const decisionRecord = {
      tag: 'CortexFollowupDecision',
      result: 'pending',
      surface: 'web',
    };
    const followUpMessage = {
      messageId: 'follow-up-1',
      metadata: { viventium: { type: 'cortex_followup' } },
    };

    const result = await persistCortexFollowUpMessageWithLedger({
      req: { user: { id: 'owner-1' } },
      parentMessageId: 'parent-1',
      followUpMessage,
      decisionRecord,
      deliveryBatch: {
        claimId: 'claim-1',
        claimed: [{ deliveryId: 'delivery-1', claimToken: 'claim-1', claimGeneration: 1 }],
      },
      dependencies: { markDropped, markPersisted, persistDecision, saveMessage },
    });

    expect(markDropped).not.toHaveBeenCalled();
    expect(markPersisted).toHaveBeenCalledWith({
      ownerId: 'owner-1',
      claims: [
        expect.objectContaining({
          deliveryId: 'delivery-1',
          claimToken: 'claim-1',
          claimGeneration: 1,
        }),
      ],
      persistedMessageId: 'follow-up-1',
      messageRevision: 1,
    });
    expect(result.decisionRecord).toEqual(
      expect.objectContaining({ result: 'persisted', deliveryStatus: 'pending' }),
    );
    expect(result.followUpMessage.metadata.viventium.cortexFollowUpDecision.result).toBe(
      'persisted',
    );
    expect(persistDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        decisionRecord: expect.objectContaining({ result: 'persisted' }),
      }),
    );
  });

  test('rejects a partial same-generation persistence settlement before reporting persisted', async () => {
    const saveMessage = jest.fn().mockResolvedValue({ messageId: 'follow-up-partial' });
    const markPersisted = jest
      .fn()
      .mockResolvedValue([{ deliveryId: 'delivery-a', claimGeneration: 4 }]);
    const persistDecision = jest.fn();

    await expect(
      persistCortexFollowUpMessageWithLedger({
        req: { user: { id: 'owner-1' } },
        parentMessageId: 'parent-1',
        followUpMessage: {
          messageId: 'follow-up-partial',
          metadata: { viventium: { type: 'cortex_followup' } },
        },
        decisionRecord: {
          tag: 'CortexFollowupDecision',
          result: 'pending',
          surface: 'web',
        },
        deliveryBatch: {
          claimId: 'claim-batch',
          claimed: [
            { deliveryId: 'delivery-a', claimToken: 'claim-batch', claimGeneration: 4 },
            { deliveryId: 'delivery-b', claimToken: 'claim-batch', claimGeneration: 4 },
          ],
        },
        dependencies: { markPersisted, persistDecision, saveMessage },
      }),
    ).rejects.toMatchObject({ code: 'cortex_insight_delivery_settlement_conflict' });

    expect(persistDecision).not.toHaveBeenCalled();
  });

  test('keeps every claimed insight pending when message persistence fails', async () => {
    const saveMessage = jest.fn().mockRejectedValue(new Error('synthetic save failure'));
    const markPersisted = jest.fn();
    const markDropped = jest.fn().mockResolvedValue([]);
    const markFailed = jest.fn().mockResolvedValue([]);
    const persistDecision = jest.fn();

    await expect(
      persistCortexFollowUpMessageWithLedger({
        req: { user: { id: 'owner-1' } },
        parentMessageId: 'parent-1',
        followUpMessage: {
          messageId: 'follow-up-1',
          metadata: { viventium: { type: 'cortex_followup' } },
        },
        decisionRecord: {
          tag: 'CortexFollowupDecision',
          result: 'pending',
          surface: 'telegram',
        },
        deliveryBatch: {
          claimId: 'claim-1',
          claimed: [{ deliveryId: 'delivery-1', claimToken: 'claim-1', claimGeneration: 1 }],
        },
        dependencies: { markDropped, markFailed, markPersisted, persistDecision, saveMessage },
      }),
    ).rejects.toThrow('synthetic save failure');

    expect(markPersisted).not.toHaveBeenCalled();
    expect(markDropped).not.toHaveBeenCalled();
    expect(markFailed).toHaveBeenCalledWith({
      ownerId: 'owner-1',
      claims: [
        expect.objectContaining({
          deliveryId: 'delivery-1',
          claimToken: 'claim-1',
          claimGeneration: 1,
        }),
      ],
      reason: 'durable_surface_persistence_failed',
    });
    expect(persistDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        decisionRecord: expect.objectContaining({
          result: 'pending',
          deliveryStatus: 'pending',
          dropReason: 'durable_surface_persistence_failed',
        }),
      }),
    );
  });

  test('keeps a completed insight pending when save resolves without a durable receipt', async () => {
    const saveMessage = jest.fn().mockResolvedValue(null);
    const markPersisted = jest.fn();
    const markDropped = jest.fn().mockResolvedValue([]);
    const markFailed = jest.fn().mockResolvedValue([]);
    const persistDecision = jest.fn();

    await expect(
      persistCortexFollowUpMessageWithLedger({
        req: { user: { id: 'owner-1' } },
        parentMessageId: 'parent-1',
        followUpMessage: {
          messageId: 'follow-up-1',
          metadata: { viventium: { type: 'cortex_followup' } },
        },
        decisionRecord: {
          tag: 'CortexFollowupDecision',
          result: 'pending',
          surface: 'telegram',
        },
        deliveryBatch: {
          claimId: 'claim-1',
          claimed: [{ deliveryId: 'delivery-1', claimToken: 'claim-1', claimGeneration: 1 }],
        },
        dependencies: { markDropped, markFailed, markPersisted, persistDecision, saveMessage },
      }),
    ).rejects.toThrow('Cortex follow-up persistence returned no receipt');

    expect(markPersisted).not.toHaveBeenCalled();
    expect(markDropped).not.toHaveBeenCalled();
    expect(markFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        claims: [expect.objectContaining({ deliveryId: 'delivery-1' })],
        reason: 'durable_surface_persistence_failed',
      }),
    );
  });

  test('marks a post-save suppressed message dropped instead of sent', async () => {
    const saveMessage = jest.fn().mockResolvedValue({ messageId: 'follow-up-1' });
    const markPersisted = jest
      .fn()
      .mockResolvedValue([{ deliveryId: 'delivery-1', claimGeneration: 1 }]);
    const markDropped = jest.fn().mockResolvedValue([]);
    const persistDecision = jest.fn();

    const result = await persistCortexFollowUpMessageWithLedger({
      req: { user: { id: 'owner-1' } },
      parentMessageId: 'parent-1',
      followUpMessage: {
        messageId: 'follow-up-1',
        metadata: { viventium: { type: 'cortex_followup' } },
      },
      decisionRecord: {
        tag: 'CortexFollowupDecision',
        result: 'pending',
        surface: 'voice',
      },
      deliveryBatch: {
        claimId: 'claim-1',
        claimed: [{ deliveryId: 'delivery-1', claimToken: 'claim-1', claimGeneration: 1 }],
      },
      dependencies: {
        afterSave: jest.fn().mockResolvedValue({ dropReason: 'voice_task_suppressed' }),
        markDropped,
        markPersisted,
        persistDecision,
        saveMessage,
      },
    });

    expect(markPersisted).toHaveBeenCalledWith(
      expect.objectContaining({ persistedMessageId: 'follow-up-1' }),
    );
    expect(markDropped).toHaveBeenCalledWith({
      ownerId: 'owner-1',
      claims: [
        expect.objectContaining({
          deliveryId: 'delivery-1',
          claimToken: 'claim-1',
          claimGeneration: 1,
        }),
      ],
      dropReason: 'voice_task_suppressed',
    });
    expect(result.dropped).toBe(true);
    expect(result.decisionRecord).toEqual(
      expect.objectContaining({
        result: 'empty',
        deliveryStatus: 'dropped',
        dropReason: 'voice_task_suppressed',
      }),
    );
  });

  test('uses closed reasons for semantic, moved-on, and failed-generation drops', () => {
    expect(
      resolveCortexInsightDropReason({
        decision: { suppressionReason: 'no_response_tag' },
      }),
    ).toBe('semantic_suppression');
    expect(
      resolveCortexInsightDropReason({
        decision: { movedOnAfterParent: true },
      }),
    ).toBe('conversation_moved_on');
    expect(
      resolveCortexInsightDropReason({
        decision: { generationFailed: true },
      }),
    ).toBe('generation_failed_without_fallback');
  });

});

test('promoting a new completed result invalidates an older delivery acknowledgement', async () => {
  const db = require('~/models');
  const { persistPreparedCortexFollowUpMessage } = require('../BackgroundCortexFollowUpService');
  const get = jest.spyOn(db, 'getMessage').mockResolvedValue({
    messageId: 'parent-promoted', parentMessageId: 'user-parent', conversationId: 'conversation-promoted',
    content: [{ type: 'cortex_insight', insight: 'Completed insight.' }],
    metadata: { viventium: { messageRevision: 2, deliveryAcknowledgement: { revision: 5 } } },
  });
  const update = jest.spyOn(db, 'updateMessage').mockResolvedValue({});
  try {
    const message = await persistPreparedCortexFollowUpMessage({
      req: { user: { id: 'owner-promoted' } }, conversationId: 'conversation-promoted',
      parentMessageId: 'parent-promoted', insightsData: { cortexCount: 1 },
    }, { text: 'Completed visible result.', shouldForceVisibleFollowUp: true,
      finalContinuationContext: { hasMovedOn: false }, conversationMessages: [] });
    expect(message.metadata.viventium.messageRevision).toBe(6);
    expect(message.metadata.viventium).not.toHaveProperty('deliveryAcknowledgement');
    expect(update).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      messageId: 'parent-promoted', text: 'Completed visible result.',
    }), expect.objectContaining({ operationKind: 'system' }));
  } finally { get.mockRestore(); update.mockRestore(); }
});
