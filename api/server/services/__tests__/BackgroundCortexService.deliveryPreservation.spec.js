jest.mock('../viventium/CortexInsightOutboxService', () => ({
  enqueueCompletedCortexInsightOutboxBatch: jest.fn(async () => ({ outboxKeys: [] })),
  settleCompletedCortexInsightOutboxBatch: jest.fn(async () => ({ deleted: 1 })),
}));
const { persistCompletedCortexGraphInsight, failClosedCortexResult, finalizeCortexResultDelivery,
  isDeliverableCortexResult, collectDeliverableCortexInsights, shouldRetryCortexResultWithFallback,
  buildCortexCompletionPayload, executeCortex } = require('../BackgroundCortexService');
const { buildCortexInsightDeliveryCandidates } = require('../viventium/CortexInsightDeliveryService');
const exactOutboxReceipt = (batch) => ({
  outboxKeys: buildCortexInsightDeliveryCandidates(batch).map((item) => item.deliveryKey),
});
describe('saved completed Cortex acceptance', () => {
  test('persists the exact normalized graph result before follow-up ownership can start', async () => {
    const recordBatch = jest.fn(async (batch) => ({
      deliveries: buildCortexInsightDeliveryCandidates(batch),
    }));
    const exactInsight = 'The exact completed graph insight.';
    const feelingSnapshot = {
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
    };

    await persistCompletedCortexGraphInsight(
      {
        req: {
          user: { id: 'owner-graph' },
          _viventiumFeelingSnapshot: feelingSnapshot,
          body: {
            conversationId: 'conversation-graph',
            streamId: 'stream-graph',
            viventiumLogicalTurnRevision: 3,
          },
        },
        conversationId: 'conversation-graph',
        parentMessageId: 'parent-graph',
        agent: { id: 'emotional-resonance', name: 'Emotional Resonance' },
        insight: exactInsight,
        surface: 'telegram',
      },
      { recordBatch },
    );

    expect(recordBatch).toHaveBeenCalledWith({
      ownerId: 'owner-graph',
      conversationId: 'conversation-graph',
      parentMessageId: 'parent-graph',
      surface: 'telegram',
      streamId: 'stream-graph',
      messageRevision: 3,
      feelingSnapshot,
      insights: [
        {
          cortexId: 'emotional-resonance',
          cortexName: 'Emotional Resonance',
          insight: exactInsight,
          status: 'completed',
        },
      ],
    });
  });

  test('keeps a completed graph result in the durable outbox when the first ledger write fails', async () => {
    const enqueueOutbox = jest.fn(async (batch) => exactOutboxReceipt(batch));
    const recordBatch = jest
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('initial ledger write failed'), { code: 'ledger_write_failed' }),
      );
    const settleOutbox = jest.fn();
    const exactInsight = 'The completed result must survive restart.';

    const result = await persistCompletedCortexGraphInsight(
      {
        req: {
          user: { id: 'owner-outbox' },
          body: {
            conversationId: 'conversation-outbox',
            streamId: 'stream-outbox',
            viventiumLogicalTurnRevision: 2,
          },
        },
        conversationId: 'conversation-outbox',
        parentMessageId: 'parent-outbox',
        agent: { id: 'emotional-resonance', name: 'Emotional Resonance' },
        insight: exactInsight,
        surface: 'telegram',
      },
      { recordBatch, enqueueOutbox, settleOutbox },
    );
    expect(result).toEqual(
      expect.objectContaining({
        deliveries: [],
        outboxPending: true,
        outboxKeys: expect.any(Array),
      }),
    );
    expect(result.outboxKeys).toHaveLength(1);
    expect(enqueueOutbox.mock.invocationCallOrder[0]).toBeLessThan(
      recordBatch.mock.invocationCallOrder[0],
    );
    expect(settleOutbox).not.toHaveBeenCalled();
  });

  test('fails closed when both private durable stores reject the completed graph result', async () => {
    const feelingSnapshot = {
      available: true,
      enabled: true,
      agentScope: 'all_agents',
      version: 41,
      asOf: '2026-08-22T12:00:00.000Z',
      capsule: 'PRIVATE_SYNTHETIC_CANARY',
      snapshotHash: 'a'.repeat(64),
      rangePromptOverrideCount: 3,
      activeRangePromptOverrideCount: 2,
      activeRangePromptOverrideChars: 120,
    };
    const recordBatch = jest
      .fn()
      .mockRejectedValue(Object.assign(new Error('ledger unavailable'), { code: 'ledger_down' }));
    const enqueueOutbox = jest
      .fn()
      .mockRejectedValue(Object.assign(new Error('outbox unavailable'), { code: 'outbox_down' }));

    let acceptanceError;
    try {
      await persistCompletedCortexGraphInsight(
        {
          req: {
            user: { id: 'owner-private-failure' },
            _viventiumFeelingSnapshot: feelingSnapshot,
            body: {
              conversationId: 'conversation-private-failure',
              streamId: 'stream-private-failure',
            },
          },
          conversationId: 'conversation-private-failure',
          parentMessageId: 'parent-private-failure',
          agent: { id: 'emotional-resonance', name: 'Emotional Resonance' },
          insight: 'Completed private result.',
          surface: 'telegram',
        },
        { recordBatch, enqueueOutbox },
      );
    } catch (error) {
      acceptanceError = error;
    }

    expect(acceptanceError).toMatchObject({
      code: 'cortex_insight_delivery_acceptance_unavailable',
      retryable: true,
    });
    const failedResult = failClosedCortexResult(
      {
        agentId: 'emotional-resonance',
        agentName: 'Emotional Resonance',
        insight: 'Completed private result.',
      },
      acceptanceError,
    );
    expect(failedResult).toEqual(
      expect.objectContaining({
        insight: null,
        errorClass: 'delivery_persistence_unavailable',
        errorCode: 'cortex_insight_delivery_acceptance_unavailable',
        retryable: true,
      }),
    );
    expect(isDeliverableCortexResult(failedResult)).toBe(false);
    expect(shouldRetryCortexResultWithFallback(failedResult)).toBe(false);
    expect(collectDeliverableCortexInsights([failedResult])).toEqual([]);
    const completionPayload = buildCortexCompletionPayload(failedResult);
    expect(completionPayload).toEqual(
      expect.objectContaining({
        status: 'error',
        error_class: 'delivery_persistence_unavailable',
        error_code: 'cortex_insight_delivery_acceptance_unavailable',
        retryable: true,
      }),
    );
    expect(completionPayload).not.toHaveProperty('insight');
    expect(JSON.stringify(failedResult)).not.toContain('Completed private result.');
    expect(failedResult).not.toHaveProperty('outboxKeys');
  });

  test.each([
    ['missing', {}],
    ['empty', { outboxKeys: [] }],
    ['non-string', { outboxKeys: [undefined] }],
    ['wrong', { outboxKeys: ['wrong-outbox-key'] }],
  ])('rejects a %s outbox receipt when the ledger also fails', async (_name, receipt) => {
    const recordBatch = jest.fn().mockRejectedValue(new Error('ledger unavailable'));
    const enqueueOutbox = jest.fn().mockResolvedValue(receipt);

    await expect(
      persistCompletedCortexGraphInsight(
        {
          req: {
            user: { id: 'owner-malformed-outbox' },
            body: { conversationId: 'conversation-malformed-outbox' },
          },
          conversationId: 'conversation-malformed-outbox',
          parentMessageId: 'parent-malformed-outbox',
          agent: { id: 'review', name: 'Review' },
          insight: 'Must not be delivered without exact acceptance.',
          surface: 'web',
        },
        { recordBatch, enqueueOutbox },
      ),
    ).rejects.toMatchObject({
      code: 'cortex_insight_delivery_acceptance_unavailable',
      retryable: true,
    });
  });

  test('does not complete, aggregate, or retry a two-store failure through executeCortex', async () => {
    const recordBatch = jest.fn().mockRejectedValue(new Error('ledger unavailable'));
    const enqueueOutbox = jest.fn().mockRejectedValue(new Error('outbox unavailable'));
    const executeOnce = jest.fn(() =>
      finalizeCortexResultDelivery(
        {
          agentId: 'review',
          agentName: 'Review',
          insight: 'Must not survive the persistence failure.',
          configuredTools: 2,
          completedToolCalls: 1,
        },
        {
          completedResultPolicy: 'deliver',
          persist: () =>
            persistCompletedCortexGraphInsight(
              {
                req: {
                  user: { id: 'owner-execution-failure' },
                  body: { conversationId: 'conversation-execution-failure' },
                },
                conversationId: 'conversation-execution-failure',
                parentMessageId: 'parent-execution-failure',
                agent: { id: 'review', name: 'Review' },
                insight: 'Must not survive the persistence failure.',
                surface: 'web',
              },
              { recordBatch, enqueueOutbox },
            ),
        },
      ),
    );

    const result = await executeCortex(
      {
        agent: {
          id: 'review',
          provider: 'anthropic',
          model: 'primary-model',
          fallback_llm_provider: 'openai',
          fallback_llm_model: 'fallback-model',
        },
        messages: [],
        runId: 'fail-closed-fallback-run',
      },
      { executeOnce },
    );

    expect(result.insight).toBeNull();
    expect(result).toEqual(
      expect.objectContaining({
        errorClass: 'delivery_persistence_unavailable',
        errorCode: 'cortex_insight_delivery_acceptance_unavailable',
        retryable: true,
      }),
    );
    expect(executeOnce).toHaveBeenCalledTimes(1);
    expect(buildCortexCompletionPayload(result)).not.toHaveProperty('insight');
    expect(collectDeliverableCortexInsights([result])).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('Must not survive the persistence failure.');
  });

});
