// VIVENTIUM START: verify Viventium background-cortex activation policy behavior.
jest.mock('../viventium/CortexInsightOutboxService', () => ({
  enqueueCompletedCortexInsightOutboxBatch: jest.fn(async () => ({
    outboxKeys: ['test-cortex-outbox'],
  })),
  settleCompletedCortexInsightOutboxBatch: jest.fn(async () => ({ deleted: 1 })),
}));

const mockPersistCortexPartsToCanonicalMessage = jest.fn(async () => []);
jest.mock('../viventium/BackgroundCortexFollowUpService', () => ({
  persistCortexPartsToCanonicalMessage: (...args) =>
    mockPersistCortexPartsToCanonicalMessage(...args),
}));

const {
  extractCortexErrorCode,
  classifyCortexPublicError,
  buildActivationPolicySection,
  applyActivationJsonMode,
  ACTIVATION_SYSTEM_PROMPT,
  classifyActivationError,
  buildCortexCompletionPayload,
  hasVisibleCortexInsight,
  failClosedCortexResult,
  finalizeCortexResultDelivery,
  isDeliverableCortexResult,
  collectDeliverableCortexInsights,
  shouldRetryCortexResultWithFallback,
  executeCortex,
  executeCortexOnce,
  bindCortexMainContextSnapshot,
  executeActivated,
  normalizeDirectActionSurfaceScopes,
  applyDirectActionOwnershipGate,
  normalizeAgentToolNames,
  countConfiguredCortexTools,
  resolveActivationPolicyMainAgent,
  summarizeActivationError,
  formatHistoryForActivation,
  getCortexAttemptGuardTimeoutMs,
  resolveBackgroundCortexFallbackAgent,
  buildActivationCooldownKey,
  buildActivationLlmConfig,
  buildActivationProviderAttempts,
  clearActivationProviderHealth,
  getActivationProviderSuppression,
  markActivationProviderUnhealthy,
  shouldAttemptSuppressedActivationProvider,
  shouldProbeSuppressedActivationAttempt,
  activationProviderAttemptsUnavailable,
  isActivationFallbackCandidate,
  parseActivationResponse,
  activationFailureVisibility,
  shouldSurfaceActivationProviderUnavailable,
  shouldSurfaceActivationTimeout,
  configuredCortexDisplayName,
  feelingTailForBackgroundAgent,
  detectActivations,
  normalizePhaseANoticeMode,
  resolvePhaseANoticeModeForRequest,
  isBackgroundCortexCancellationSignal,
  prepareCortexConversationProviderCapability,
  extractCompletedCortexGraphInsight,
  persistCompletedCortexGraphInsight,
  normalizeCortexInsight,
  buildCortexPromptFrame,
  createBackgroundRes,
} = require('../BackgroundCortexService');
const { captureMainContextSnapshot } = require('../viventium/ViventiumMainContextService');
const { setTrustedInteractionContext } = require('../viventium/interactionContext');
const { GraphEvents } = require('@librechat/agents');
const { logger } = require('@librechat/data-schemas');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { resolvePromptRefs } = require('../../../../scripts/viventium-sync-agents');
const {
  buildCortexInsightDeliveryCandidates,
} = require('../viventium/CortexInsightDeliveryService');

const exactOutboxReceipt = (batch) => ({
  outboxKeys: buildCortexInsightDeliveryCandidates(batch).map((delivery) => delivery.deliveryKey),
});

describe('BackgroundCortexService activation policy helpers', () => {
  beforeEach(() => {
    mockPersistCortexPartsToCanonicalMessage.mockClear();
  });

  afterEach(() => {
    clearActivationProviderHealth();
    delete process.env.VIVENTIUM_CORTEX_PHASE_A_NOTICE_MODE;
  });

  function requestWithMainSnapshot() {
    const req = {
      user: { id: 'c43-owner', role: 'USER' },
      body: { conversationId: 'c43-conversation' },
    };
    setTrustedInteractionContext(req, {
      actor_kind: 'external_user',
      origin: 'interactive',
      surface: 'web',
      conversation_id: 'c43-conversation',
      logical_turn_id: 'c43-turn',
      revision: 3,
      source_event_id: 'c43-event',
      source_segments: [
        {
          source_event_id: 'c43-event',
          source_index: 0,
          source_message_id: 'c43-current-input',
          text: 'Current user input.',
        },
      ],
    });
    const mainAgent = {
      id: 'main-agent',
      instructions: 'Main policy.',
      tools: [],
      model_parameters: {
        configuration: {
          defaultHeaders: {
            'X-GlassHive-Stable-Authority-SHA256': 'a'.repeat(64),
          },
        },
      },
    };
    captureMainContextSnapshot(req, {
      agent: mainAgent,
      messages: [{ role: 'user', content: 'Current user input.' }],
      visibleMessages: [
        {
          messageId: 'c43-current-input',
          parentMessageId: 'c43-parent',
          isCreatedByUser: true,
          text: 'Current user input.',
        },
      ],
    });
    return req;
  }

  function cortexRuntimeAgent() {
    return {
      id: 'cortex-agent',
      model_parameters: { configuration: { defaultHeaders: {} } },
    };
  }

  test('binds the accepted snapshot and carries the triggering current input', () => {
    const req = requestWithMainSnapshot();
    const target = cortexRuntimeAgent();
    const result = bindCortexMainContextSnapshot(req, target, { required: true });
    const headers = target.model_parameters.configuration.defaultHeaders;
    const chain = JSON.parse(
      Buffer.from(headers['X-Viventium-Visible-Message-Chain-B64'], 'base64').toString('utf8'),
    );

    expect(result.bound).toBe(true);
    expect(chain.at(-1)).toMatchObject({ id: 'c43-current-input', role: 'user' });
    expect(headers).toMatchObject({
      'X-Viventium-Main-Context-Protocol': 'main_context_v1',
      'X-Viventium-Main-Context-Owner': 'core',
      'X-GlassHive-Stable-Authority-SHA256': result.snapshot.stableAuthoritySha256,
      'X-Viventium-Main-Context-Snapshot-SHA256': result.snapshot.snapshotSha256,
      'X-Viventium-Main-Context-Epoch': result.snapshot.contextEpoch,
      'X-Viventium-Continuity-Agent-Id': result.snapshot.agentId,
      'X-Viventium-Logical-Turn-Id': result.snapshot.logicalTurnId,
      'X-Viventium-Logical-Turn-Revision': String(result.snapshot.revision),
    });
  });

  test('does not invent Main authority when the optional snapshot is missing', () => {
    const req = { user: { id: 'c43-internal-owner' }, body: {} };
    const target = cortexRuntimeAgent();
    const result = bindCortexMainContextSnapshot(req, target);

    expect(result).toEqual({ bound: false, snapshot: null });
    expect(target.model_parameters.configuration.defaultHeaders).toEqual({});
  });

  test('fails closed with the existing unavailable code for a workspace path without a snapshot', () => {
    expect(() =>
      bindCortexMainContextSnapshot(
        { user: { id: 'c43-workspace-owner' }, body: {} },
        cortexRuntimeAgent(),
        { required: true },
      ),
    ).toThrow(expect.objectContaining({ code: 'phase_b_main_context_unavailable' }));
  });

  test('refuses a stale or mismatched existing Main binding', () => {
    const req = requestWithMainSnapshot();
    const target = cortexRuntimeAgent();
    target.model_parameters.configuration.defaultHeaders = {
      'X-Viventium-Main-Context-Protocol': 'main_context_v1',
      'X-Viventium-Main-Context-Snapshot-SHA256': '0'.repeat(64),
    };

    expect(() => bindCortexMainContextSnapshot(req, target)).toThrow(
      expect.objectContaining({ code: 'phase_b_main_context_binding_failed' }),
    );
  });

  test('keeps request identity and the existing tool-loading request boundary unchanged', () => {
    const req = requestWithMainSnapshot();
    const target = cortexRuntimeAgent();
    const before = JSON.stringify(req);

    bindCortexMainContextSnapshot(req, target, { required: true });

    expect(JSON.stringify(req)).toBe(before);
    expect(req).not.toBe(target);
    expect(
      target.model_parameters.configuration.defaultHeaders['X-Viventium-Main-Context-Owner'],
    ).toBe('core');
  });

  test('binds prompt telemetry to the actual cortex agent identity', () => {
    const frame = buildCortexPromptFrame({
      agentId: 'agent_synthetic_cortex',
      promptFamily: 'cortex_execution',
      surface: 'web',
      provider: 'synthetic-provider',
      model: 'synthetic-model',
      decisionState: { should_respond: true },
    });

    expect(frame.agent_id_hash).toMatch(/^[0-9a-f]{16}$/);
    expect(frame.agent_id_hash).not.toBe('missing');
    expect(frame.decision_state.agent_id_hash).toBe(frame.agent_id_hash);
    expect(JSON.stringify(frame)).not.toContain('agent_synthetic_cortex');
  });

  test('preserves structured internal cortex output without applying user-facing summary extraction', () => {
    const structured = JSON.stringify({
      version: 1,
      summary: 'Bounded earlier context.',
      pendingAsks: ['Finish the report.'],
    });

    expect(normalizeCortexInsight(structured, 'structured')).toBe(structured);
    expect(normalizeCortexInsight(structured, 'user_facing')).toBe('Bounded earlier context.');
  });

  test('normalizes the authoritative completed graph before user-facing persistence and delivery', async () => {
    const structured = JSON.stringify({
      version: 1,
      summary: 'User-facing completed summary.',
      privateEvidence: ['internal-only-detail'],
    });
    const persistCompletedInsightFn = jest.fn(async () => ({ durableAcceptance: 'ledger' }));
    const result = await executeCortexOnce(
      {
        agent: { id: 'summary-cortex', name: 'Summary', provider: 'anthropic', tools: [] },
        messages: [],
        runId: 'summary-parent',
        conversationId: 'summary-conversation',
        contextMode: 'minimal',
        req: {
          user: { id: 'summary-owner', role: 'USER' },
          body: { conversationId: 'summary-conversation' },
          config: {},
        },
      },
      {
        initializeAgentFn: jest.fn(async ({ agent }) => ({
          ...agent,
          instructions: '',
          tools: [],
          recursion_limit: 4,
        })),
        createRunFn: jest.fn(async () => ({ processStream: jest.fn(async () => structured) })),
        persistCompletedInsightFn,
      },
    );

    expect(result.insight).toBe('User-facing completed summary.');
    expect(persistCompletedInsightFn).toHaveBeenCalledWith(
      expect.objectContaining({ insight: 'User-facing completed summary.' }),
    );
    expect(JSON.stringify(result)).not.toContain('internal-only-detail');
  });

  test('preserves the authoritative structured graph for an internal compaction caller', async () => {
    const structured = JSON.stringify({
      version: 1,
      summary: 'Compaction summary.',
      pendingAsks: ['Keep this exact field.'],
    });
    const persistCompletedInsightFn = jest.fn();
    const result = await executeCortexOnce(
      {
        agent: { id: 'main-compactor', name: 'Main Compactor', provider: 'anthropic', tools: [] },
        messages: [],
        runId: 'compactor-parent',
        conversationId: 'compactor-conversation',
        contextMode: 'minimal',
        completedResultPolicy: 'internal',
        insightMode: 'structured',
        req: {
          user: { id: 'compactor-owner', role: 'USER' },
          body: { conversationId: 'compactor-conversation' },
          config: {},
        },
      },
      {
        initializeAgentFn: jest.fn(async ({ agent }) => ({
          ...agent,
          instructions: '',
          tools: [],
          recursion_limit: 4,
        })),
        createRunFn: jest.fn(async () => ({ processStream: jest.fn(async () => structured) })),
        persistCompletedInsightFn,
      },
    );

    expect(result.insight).toBe(structured);
    expect(persistCompletedInsightFn).not.toHaveBeenCalled();
  });

  test('rejects an unknown completed-graph insight mode before provider execution', async () => {
    const initializeAgentFn = jest.fn();
    await expect(
      executeCortexOnce(
        {
          agent: { id: 'invalid-mode-cortex', provider: 'anthropic' },
          messages: [],
          runId: 'invalid-mode-parent',
          insightMode: 'unknown',
        },
        { initializeAgentFn },
      ),
    ).rejects.toThrow('insightMode must be "user_facing" or "structured"');
    expect(initializeAgentFn).not.toHaveBeenCalled();
  });

  test.each([
    [
      'invalid Feelings snapshot',
      {
        user: { id: 'acceptance-owner', role: 'USER' },
        body: { conversationId: 'acceptance-conversation' },
        _viventiumFeelingSnapshot: {
          capsule: 'PRIVATE_SYNTHETIC_INVALID_FEELING_CANARY',
          snapshotHash: 'invalid',
        },
        config: {},
      },
    ],
    ['missing owner and conversation identity', { user: { role: 'USER' }, body: {}, config: {} }],
  ])('fails closed before store writes for %s', async (_name, req) => {
    const insight = 'PRIVATE_SYNTHETIC_PRESTORE_INSIGHT';
    const recordBatch = jest.fn();
    const enqueueOutbox = jest.fn();
    const warnSpy = jest.spyOn(logger, 'warn');
    const errorSpy = jest.spyOn(logger, 'error');
    const onCortexComplete = jest.fn();
    const onAllComplete = jest.fn();
    const response = createBackgroundRes();
    response.write = jest.fn(() => true);
    const cortexAgent = {
      id: 'prestore-cortex',
      name: 'Prestore',
      provider: 'anthropic',
      tools: [],
      fallback_llm_provider: 'openai',
      fallback_llm_model: 'synthetic-fallback-model',
    };
    const productionExecuteOnce = jest.fn((params) =>
      executeCortexOnce(
        { ...params, contextMode: 'minimal' },
        {
          initializeAgentFn: jest.fn(async ({ agent }) => ({
            ...agent,
            instructions: '',
            tools: [],
            recursion_limit: 4,
          })),
          createRunFn: jest.fn(async () => ({ processStream: jest.fn(async () => insight) })),
          persistCompletedInsightFn: (params) =>
            persistCompletedCortexGraphInsight(params, { recordBatch, enqueueOutbox }),
        },
      ),
    );
    try {
      const result = await executeActivated(
        {
          req,
          res: response,
          mainAgent: { provider: 'agents' },
          messages: [],
          runId: 'prestore-parent',
          conversationId: req.body.conversationId,
          activatedCortices: [
            {
              agentId: cortexAgent.id,
              cortexName: cortexAgent.name,
              confidence: 0.9,
              reason: 'synthetic-prestore-validation',
            },
          ],
          onCortexComplete,
          onAllComplete,
        },
        {
          loadAgentFn: jest.fn(async () => cortexAgent),
          loadModelsConfigFn: jest.fn(async () => ({})),
          resolveFallbackAgentFn: jest.fn(async () => ({
            ...cortexAgent,
            id: 'prestore-cortex-fallback',
            provider: 'openai',
          })),
          executeCortexFn: (params) =>
            executeCortex(params, { executeOnce: productionExecuteOnce }),
        },
      );

      expect(result).toEqual({ insights: [] });
      expect(productionExecuteOnce).toHaveBeenCalledTimes(1);
      expect(onCortexComplete).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'error',
          error_class: 'delivery_persistence_unavailable',
          error_code: 'cortex_insight_delivery_acceptance_unavailable',
          retryable: true,
        }),
      );
      expect(onCortexComplete.mock.calls[0][0]).not.toHaveProperty('insight');
      expect(onAllComplete).toHaveBeenCalledWith(
        expect.objectContaining({
          insights: [],
          mergedPrompt: '',
          cortexCount: 0,
          hasErrors: true,
        }),
      );
      expect(recordBatch).not.toHaveBeenCalled();
      expect(enqueueOutbox).not.toHaveBeenCalled();
      expect(response.write).not.toHaveBeenCalled();
      const publicSurfaces = JSON.stringify([
        result,
        onCortexComplete.mock.calls,
        onAllComplete.mock.calls,
        response.write.mock.calls,
        warnSpy.mock.calls,
        errorSpy.mock.calls,
      ]);
      expect(publicSurfaces).not.toContain(insight);
      expect(publicSurfaces).not.toContain('PRIVATE_SYNTHETIC_INVALID_FEELING_CANARY');
      expect(publicSurfaces).not.toContain('acceptance-owner');
      expect(publicSurfaces).not.toContain('acceptance-conversation');
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  test.each([
    ['Error object', new Error('synthetic_completed_result_programming_defect')],
    ['primitive rejection', 'PRIVATE_SYNTHETIC_PRIMITIVE_PROGRAMMING_DEFECT'],
  ])(
    'propagates an unrelated completed-result persistence %s without provider fallback',
    async (_kind, programmingFailure) => {
      const initializeAgentFn = jest.fn(async ({ agent }) => ({
        ...agent,
        instructions: '',
        tools: [],
        recursion_limit: 4,
      }));
      const createRunFn = jest.fn(async () => ({
        processStream: jest.fn(async () => 'Synthetic accepted-shape insight.'),
      }));
      const productionExecuteOnce = jest.fn((params) =>
        executeCortexOnce(
          { ...params, contextMode: 'minimal' },
          {
            initializeAgentFn,
            createRunFn,
            persistCompletedInsightFn: jest.fn(async () => {
              throw programmingFailure;
            }),
          },
        ),
      );
      const cortexAgent = {
        id: 'programming-defect-cortex',
        name: 'Programming Defect',
        provider: 'anthropic',
        tools: [],
        fallback_llm_provider: 'openai',
        fallback_llm_model: 'synthetic-fallback-model',
      };
      const onCortexComplete = jest.fn();
      const onAllComplete = jest.fn();
      const response = createBackgroundRes();
      response.write = jest.fn(() => true);

      const execution = executeActivated(
        {
          req: {
            user: { id: 'programming-defect-owner', role: 'USER' },
            body: { conversationId: 'programming-defect-conversation' },
            config: {},
          },
          res: response,
          mainAgent: { provider: 'agents' },
          messages: [],
          runId: 'programming-defect-parent',
          conversationId: 'programming-defect-conversation',
          activatedCortices: [
            {
              agentId: cortexAgent.id,
              cortexName: cortexAgent.name,
              confidence: 0.9,
              reason: 'synthetic-programming-defect',
            },
          ],
          onCortexComplete,
          onAllComplete,
        },
        {
          loadAgentFn: jest.fn(async () => cortexAgent),
          loadModelsConfigFn: jest.fn(async () => ({})),
          resolveFallbackAgentFn: jest.fn(async () => ({
            ...cortexAgent,
            id: 'programming-defect-fallback',
            provider: 'openai',
          })),
          executeCortexFn: (params) =>
            executeCortex(params, { executeOnce: productionExecuteOnce }),
        },
      );

      if (programmingFailure instanceof Error) {
        await expect(execution).rejects.toBe(programmingFailure);
      } else {
        await expect(execution).rejects.toMatchObject({
          code: 'cortex_completed_result_programming_defect',
          message: 'Completed-result persistence dependency rejected with a non-Error value',
        });
      }

      expect(productionExecuteOnce).toHaveBeenCalledTimes(1);
      expect(initializeAgentFn).toHaveBeenCalledTimes(1);
      expect(createRunFn).toHaveBeenCalledTimes(1);
      expect(onCortexComplete).not.toHaveBeenCalled();
      expect(onAllComplete).not.toHaveBeenCalled();
      expect(response.write).not.toHaveBeenCalled();
    },
  );

  test('extracts the exact final insight from the completed graph instead of stale streamed text', () => {
    const completedContent = [
      { type: 'text', text: 'I will inspect the evidence.', tool_call_ids: ['call-1'] },
      { type: 'tool_call', tool_call: { id: 'call-1', name: 'search' } },
      { type: 'tool_result', tool_use_id: 'call-1', content: 'synthetic evidence' },
      {
        type: 'text',
        text: JSON.stringify({ summary: 'The exact completed insight.' }),
      },
    ];

    const extracted = extractCompletedCortexGraphInsight({
      completedContent,
      streamedContentParts: [{ type: 'text', text: 'Stale streamed text.' }],
    });

    expect(extracted).toBe(JSON.stringify({ summary: 'The exact completed insight.' }));
    expect(normalizeCortexInsight(extracted)).toBe('The exact completed insight.');
  });

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

  test('fails closed through production execution and both completion callbacks', async () => {
    const insight = 'PRIVATE_SYNTHETIC_PRODUCTION_WIRING_INSIGHT';
    const recordBatch = jest.fn().mockRejectedValue(new Error('ledger unavailable'));
    const enqueueOutbox = jest.fn().mockRejectedValue(new Error('outbox unavailable'));
    const initializeAgentFn = jest.fn(async ({ agent }) => ({
      ...agent,
      id: agent.id,
      provider: agent.provider,
      instructions: '',
      tools: [],
      recursion_limit: 4,
    }));
    const createRunFn = jest.fn(async ({ customHandlers }) => ({
      processStream: jest.fn(async () => {
        await customHandlers[GraphEvents.ON_MESSAGE_DELTA].handle(
          GraphEvents.ON_MESSAGE_DELTA,
          {
            agentId: 'review-production-wiring',
            delta: { content: [{ type: 'text', text: insight }] },
          },
          {},
        );
        return [{ type: 'text', text: insight }];
      }),
    }));
    const persistCompletedInsightFn = jest.fn((params) =>
      persistCompletedCortexGraphInsight(params, { recordBatch, enqueueOutbox }),
    );
    const productionExecuteOnce = jest.fn((params) =>
      executeCortexOnce(
        { ...params, contextMode: 'minimal' },
        { initializeAgentFn, createRunFn, persistCompletedInsightFn },
      ),
    );
    const cortexAgent = {
      id: 'review-production-wiring',
      name: 'Review',
      provider: 'anthropic',
      model: 'synthetic-primary-model',
      tools: [],
      fallback_llm_provider: 'openai',
      fallback_llm_model: 'synthetic-fallback-model',
    };
    const onCortexComplete = jest.fn();
    const onAllComplete = jest.fn();
    const response = createBackgroundRes();
    response.write = jest.fn(() => true);

    const result = await executeActivated(
      {
        req: {
          user: { id: 'owner-production-wiring', role: 'USER' },
          body: { conversationId: 'conversation-production-wiring' },
          config: {
            endpoints: {
              agents: {
                allowedProviders: ['anthropic', 'openai'],
                providerCapabilities: {},
                capabilityRequiredProviders: [],
              },
            },
          },
        },
        res: response,
        mainAgent: { provider: 'agents' },
        messages: [],
        runId: 'parent-production-wiring',
        conversationId: 'conversation-production-wiring',
        activatedCortices: [
          {
            agentId: cortexAgent.id,
            cortexName: cortexAgent.name,
            confidence: 0.9,
            reason: 'synthetic-production-wiring',
          },
        ],
        onCortexComplete,
        onAllComplete,
      },
      {
        loadAgentFn: jest.fn(async () => cortexAgent),
        loadModelsConfigFn: jest.fn(async () => ({})),
        resolveFallbackAgentFn: jest.fn(async () => ({
          ...cortexAgent,
          id: 'review-production-wiring-fallback',
          provider: 'openai',
          model: 'synthetic-fallback-model',
        })),
        executeCortexFn: (params) => executeCortex(params, { executeOnce: productionExecuteOnce }),
      },
    );

    expect(result).toEqual({ insights: [] });
    expect(productionExecuteOnce).toHaveBeenCalledTimes(1);
    expect(recordBatch).toHaveBeenCalledTimes(1);
    expect(enqueueOutbox).toHaveBeenCalledTimes(1);
    expect(onCortexComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'error',
        error_class: 'delivery_persistence_unavailable',
        error_code: 'cortex_insight_delivery_acceptance_unavailable',
        retryable: true,
      }),
    );
    expect(onCortexComplete.mock.calls[0][0]).not.toHaveProperty('insight');
    expect(onAllComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        insights: [],
        mergedPrompt: '',
        cortexCount: 0,
        hasErrors: true,
        errors: [
          expect.objectContaining({
            error_class: 'delivery_persistence_unavailable',
            error_code: 'cortex_insight_delivery_acceptance_unavailable',
            retryable: true,
          }),
        ],
      }),
    );
    expect(
      JSON.stringify([
        result,
        response.write.mock.calls,
        onCortexComplete.mock.calls,
        onAllComplete.mock.calls,
      ]),
    ).not.toContain(insight);
    expect(response.write).not.toHaveBeenCalled();
  });

  test('releases an accepted production insight once through its completion callback, not raw handlers', async () => {
    const insight = 'SYNTHETIC_ACCEPTED_PRODUCTION_WIRING_INSIGHT';
    const recordBatch = jest.fn().mockRejectedValue(new Error('ledger unavailable'));
    const enqueueOutbox = jest.fn(async (batch) => exactOutboxReceipt(batch));
    const initializeAgentFn = jest.fn(async ({ agent }) => ({
      ...agent,
      instructions: '',
      tools: [],
      recursion_limit: 4,
    }));
    const createRunFn = jest.fn(async ({ customHandlers }) => ({
      processStream: jest.fn(async () => {
        await customHandlers[GraphEvents.ON_MESSAGE_DELTA].handle(
          GraphEvents.ON_MESSAGE_DELTA,
          {
            agentId: 'review-accepted-production-wiring',
            delta: { content: [{ type: 'text', text: insight }] },
          },
          {},
        );
        return [{ type: 'text', text: insight }];
      }),
    }));
    const persistCompletedInsightFn = jest.fn((params) =>
      persistCompletedCortexGraphInsight(params, { recordBatch, enqueueOutbox }),
    );
    const productionExecuteOnce = jest.fn((params) =>
      executeCortexOnce(
        { ...params, contextMode: 'minimal' },
        { initializeAgentFn, createRunFn, persistCompletedInsightFn },
      ),
    );
    const cortexAgent = {
      id: 'review-accepted-production-wiring',
      name: 'Review',
      provider: 'anthropic',
      model: 'synthetic-primary-model',
      tools: [],
    };
    const response = createBackgroundRes();
    response.write = jest.fn(() => true);
    const onCortexComplete = jest.fn();
    const onAllComplete = jest.fn();

    const result = await executeActivated(
      {
        req: {
          user: { id: 'owner-accepted-production-wiring', role: 'USER' },
          body: { conversationId: 'conversation-accepted-production-wiring' },
          config: {
            endpoints: {
              agents: {
                allowedProviders: ['anthropic'],
                providerCapabilities: {},
                capabilityRequiredProviders: [],
              },
            },
          },
        },
        res: response,
        mainAgent: { provider: 'agents' },
        messages: [],
        runId: 'parent-accepted-production-wiring',
        conversationId: 'conversation-accepted-production-wiring',
        activatedCortices: [
          {
            agentId: cortexAgent.id,
            cortexName: cortexAgent.name,
            confidence: 0.9,
            reason: 'synthetic-accepted-production-wiring',
          },
        ],
        onCortexComplete,
        onAllComplete,
      },
      {
        loadAgentFn: jest.fn(async () => cortexAgent),
        executeCortexFn: (params) => executeCortex(params, { executeOnce: productionExecuteOnce }),
      },
    );

    expect(response.write).not.toHaveBeenCalled();
    expect(onCortexComplete).toHaveBeenCalledTimes(1);
    expect(onCortexComplete).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'complete', insight }),
    );
    expect(onAllComplete).toHaveBeenCalledTimes(1);
    expect(result.insights).toEqual([expect.objectContaining({ insight })]);
    expect(
      JSON.stringify(onCortexComplete.mock.calls).match(new RegExp(insight, 'g')),
    ).toHaveLength(1);
  });

  test.each([
    ['empty', {}],
    [
      'partial',
      { deliveries: [{ deliveryId: 'wrong-delivery', graphResultHash: 'a'.repeat(64) }] },
    ],
    ['malformed', { deliveries: 'not-an-array' }],
  ])(
    'keeps the initial completed graph outbox pending after a %s ledger acceptance',
    async (_name, receipt) => {
      const enqueueOutbox = jest.fn(async (batch) => exactOutboxReceipt(batch));
      const recordBatch = jest.fn().mockResolvedValue(receipt);
      const settleOutbox = jest.fn().mockResolvedValue({ deleted: 1 });

      await expect(
        persistCompletedCortexGraphInsight(
          {
            req: {
              user: { id: 'owner-initial-acceptance' },
              body: {
                conversationId: 'conversation-initial-acceptance',
                streamId: 'stream-initial-acceptance',
              },
            },
            conversationId: 'conversation-initial-acceptance',
            parentMessageId: 'parent-initial-acceptance',
            agent: { id: 'review', name: 'Review' },
            insight: 'The exact completed graph result remains durable.',
            surface: 'web',
          },
          { recordBatch, enqueueOutbox, settleOutbox },
        ),
      ).resolves.toEqual(
        expect.objectContaining({
          deliveries: [],
          outboxPending: true,
          outboxKeys: expect.any(Array),
          outboxErrorCode: 'cortex_insight_delivery_acceptance_conflict',
        }),
      );
      expect(settleOutbox).not.toHaveBeenCalled();
    },
  );

  test('installs invocation-fresh capability refresh after the scoped cortex bundle', async () => {
    const attachBundle = jest.fn().mockResolvedValue(true);
    const installRefresher = jest.fn().mockReturnValue(true);
    const args = {
      targetAgent: { id: 'cortex-runtime' },
      declaredAgent: { id: 'cortex-declared' },
      req: { user: { id: 'user-synthetic' } },
      capability: { workspace_binding: true },
      requestBody: { conversationId: 'conversation-synthetic', messageId: 'message-synthetic' },
    };

    await expect(
      prepareCortexConversationProviderCapability({
        ...args,
        attachBundle,
        installRefresher,
      }),
    ).resolves.toBe(true);
    expect(attachBundle).toHaveBeenCalledWith(args);
    expect(installRefresher).toHaveBeenCalledWith(args);
  });

  test('keeps detached Phase B alive after Main cleanup but honors intentional Stop', () => {
    expect(
      isBackgroundCortexCancellationSignal({ aborted: true, reason: 'generation_completed' }),
    ).toBe(false);
    expect(isBackgroundCortexCancellationSignal({ aborted: true, reason: 'user_cancelled' })).toBe(
      true,
    );
    expect(isBackgroundCortexCancellationSignal({ aborted: false })).toBe(false);
    expect(isBackgroundCortexCancellationSignal(null)).toBe(false);
  });

  test('forwards the active user message ID into cortex initialization', async () => {
    const initializeAgentFn = jest.fn().mockResolvedValue({
      id: 'cortex-runtime',
      provider: 'openai',
      model: 'test-model',
      model_parameters: { model: 'test-model' },
      tools: [],
      instructions: '',
    });
    const createRunFn = jest.fn().mockResolvedValue({
      processStream: jest.fn().mockResolvedValue([{ type: 'text', text: 'done' }]),
    });
    const req = {
      user: { id: 'user-synthetic' },
      body: { conversationId: 'conversation-synthetic', parentMessageId: 'prior-message' },
      config: {
        endpoints: {
          agents: { allowedProviders: ['openai'], providerCapabilities: {} },
        },
      },
    };

    await executeCortexOnce(
      {
        agent: {
          id: 'cortex-declared',
          provider: 'openai',
          model: 'test-model',
          model_parameters: { model: 'test-model' },
          tools: [],
        },
        messages: [],
        runId: 'cortex-run',
        conversationId: 'conversation-synthetic',
        activeMessageId: 'current-user-turn',
        req,
        completedResultPolicy: 'internal',
      },
      { initializeAgentFn, createRunFn },
    );

    expect(initializeAgentFn).toHaveBeenCalledWith(
      expect.objectContaining({ activeMessageId: 'current-user-turn' }),
      expect.any(Object),
    );
  });

  test('keeps specialist background cortices independent from the pinned embodiment capsule', () => {
    const capsule = '<viventium_feeling_state>\n- Energy: steady\n</viventium_feeling_state>';
    expect(
      feelingTailForBackgroundAgent({
        available: true,
        enabled: true,
        agentScope: 'all_agents',
        capsule,
      }),
    ).toBe('');
    expect(
      feelingTailForBackgroundAgent({
        available: true,
        enabled: true,
        agentScope: 'conscious_agent',
        capsule,
      }),
    ).toBe('');
    expect(
      feelingTailForBackgroundAgent({
        available: true,
        enabled: false,
        agentScope: 'all_agents',
        capsule,
      }),
    ).toBe('');
  });

  test('resolves Phase A notice modes from env with voice-only early notice support', () => {
    expect(normalizePhaseANoticeMode('all_within_budget')).toBe('all_within_budget');
    expect(normalizePhaseANoticeMode('any_activated')).toBe('first_activation_continue');

    expect(
      resolvePhaseANoticeModeForRequest({
        body: { voiceMode: true, viventiumInputMode: 'voice_call' },
      }),
    ).toBe('first_activation_continue');
    expect(resolvePhaseANoticeModeForRequest({ body: { voiceMode: false } })).toBe(
      'all_within_budget',
    );

    process.env.VIVENTIUM_CORTEX_PHASE_A_NOTICE_MODE = 'any_activated_on_voice';
    expect(
      resolvePhaseANoticeModeForRequest({
        body: { voiceMode: true, viventiumInputMode: 'voice_call' },
      }),
    ).toBe('first_activation_continue');
    expect(resolvePhaseANoticeModeForRequest({ body: { voiceMode: false } })).toBe(
      'all_within_budget',
    );
  });

  test('first activation notice returns early while final detection continues', async () => {
    jest.useFakeTimers();
    const events = [];
    const detectPromise = detectActivations({
      req: { body: { voiceMode: true }, viventiumVoiceLogLatency: false },
      mainAgent: {
        provider: 'anthropic',
        tools: [],
        background_cortices: [{ agent_id: 'agent_fast' }, { agent_id: 'agent_slow' }],
      },
      messages: [],
      runId: 'run_notice',
      timeBudgetMs: 200,
      noticeMode: 'first_activation_continue',
      loadAgentFn: jest.fn().mockImplementation(({ agent_id }) =>
        Promise.resolve({
          name: agent_id === 'agent_fast' ? 'Fast Cortex' : 'Slow Cortex',
          description: `${agent_id} description`,
        }),
      ),
      activationRunner: ({ cortexConfig }) =>
        new Promise((resolve) => {
          const isFast = cortexConfig.agent_id === 'agent_fast';
          setTimeout(
            () =>
              resolve({
                shouldActivate: true,
                confidence: isFast ? 0.95 : 0.88,
                reason: isFast ? 'fast_yes' : 'slow_yes',
              }),
            isFast ? 10 : 80,
          );
        }),
    });

    await jest.advanceTimersByTimeAsync(15);
    const early = await detectPromise;
    expect(early.earlyReturned).toBe(true);
    expect(early.activatedCortices).toHaveLength(1);
    expect(early.activatedCortices[0]).toEqual(
      expect.objectContaining({ agentId: 'agent_fast', cortexName: 'Fast Cortex' }),
    );
    expect(typeof early.finalDetectionPromise?.then).toBe('function');

    await jest.advanceTimersByTimeAsync(100);
    const finalResult = await early.finalDetectionPromise;
    expect(finalResult.earlyReturned).toBe(false);
    expect(finalResult.activatedCortices.map((cortex) => cortex.agentId).sort()).toEqual([
      'agent_fast',
      'agent_slow',
    ]);
    expect(events).toEqual([]);
    jest.useRealTimers();
  });

  test('keeps activation classifier output strictly JSON-only', () => {
    expect(ACTIVATION_SYSTEM_PROMPT).toContain('Return only one valid JSON object');
    expect(ACTIVATION_SYSTEM_PROMPT).toContain('Do not include markdown');

    const llmConfig = applyActivationJsonMode({
      providerName: 'groq',
      llmConfig: { provider: 'openAI', modelKwargs: { top_p: 1 } },
    });

    expect(llmConfig.modelKwargs).toEqual({
      top_p: 1,
      response_format: { type: 'json_object' },
    });
  });

  test('uses JSON mode and low hidden reasoning for Groq GPT-OSS activation', async () => {
    const llmConfig = await buildActivationLlmConfig({
      providerName: 'groq',
      model: 'openai/gpt-oss-120b',
      req: {
        config: {
          endpoints: {
            agents: { activationOpenAITransportProviders: ['groq'] },
            custom: [],
          },
        },
      },
    });

    expect(llmConfig.provider).toBe('openAI');
    expect(llmConfig.temperature).toBeUndefined();
    expect(llmConfig.modelKwargs).toEqual({
      reasoning_effort: 'low',
      reasoning_format: 'hidden',
      seed: 0,
      response_format: { type: 'json_object' },
    });
  });

  test('disables Qwen thinking for low-latency Groq activation classification', async () => {
    const llmConfig = await buildActivationLlmConfig({
      providerName: 'groq',
      model: 'qwen/qwen3.6-27b',
      req: {
        config: {
          endpoints: {
            agents: { activationOpenAITransportProviders: ['groq'] },
            custom: [],
          },
        },
      },
    });

    expect(llmConfig.provider).toBe('openAI');
    expect(llmConfig.temperature).toBe(0.1);
    expect(llmConfig.modelKwargs).toEqual({
      reasoning_effort: 'none',
      reasoning_format: 'hidden',
      seed: 0,
      response_format: { type: 'json_object' },
    });
  });

  test('does not force provider JSON mode onto OpenAI reasoning activation fallback', () => {
    const llmConfig = applyActivationJsonMode({
      providerName: 'openai',
      model: 'gpt-5.4',
      llmConfig: { provider: 'openAI', model: 'gpt-5.4' },
    });

    expect(llmConfig.modelKwargs).toBeUndefined();
  });

  test('keeps Groq as the primary activation classifier before fallbacks', () => {
    const attempts = buildActivationProviderAttempts({
      provider: 'groq',
      model: 'qwen/qwen3.6-27b',
      fallbacks: [
        { provider: 'groq', model: 'qwen/qwen3.6-27b' },
        { provider: 'xai', model: 'grok-4.20-non-reasoning' },
        { provider: 'anthropic', model: 'claude-haiku-4-5' },
        { provider: 'openai', model: 'gpt-5.4' },
      ],
    });

    expect(attempts).toEqual([
      {
        provider: 'groq',
        model: 'qwen/qwen3.6-27b',
        source: 'primary',
      },
      {
        provider: 'xai',
        model: 'grok-4.20-non-reasoning',
        source: 'fallback',
      },
      {
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        source: 'fallback',
      },
      {
        provider: 'openai',
        model: 'gpt-5.4',
        source: 'fallback',
      },
    ]);
  });

  test('retries activation fallbacks when the selected model is removed or rejects JSON output', () => {
    expect(isActivationFallbackCandidate({ code: 'MODEL_NOT_FOUND', status: 404 })).toBe(true);
    expect(isActivationFallbackCandidate({ code: 'MODEL_DECOMMISSIONED', status: 404 })).toBe(true);
    expect(isActivationFallbackCandidate({ code: 'JSON_VALIDATE_FAILED', status: 400 })).toBe(true);
    expect(
      isActivationFallbackCandidate(new Error('provider initialization failed'), {
        class: 'provider_error',
        status: null,
        code: '',
      }),
    ).toBe(true);
    expect(isActivationFallbackCandidate({ code: 'INVALID_REQUEST', status: 400 })).toBe(false);
  });

  test('treats an unparseable completed classifier response as unavailable fallback evidence', () => {
    let parseError;
    try {
      parseActivationResponse('provider returned prose instead of the required JSON object');
    } catch (error) {
      parseError = error;
    }

    expect(parseError).toEqual(
      expect.objectContaining({
        code: 'JSON_PARSE_FAILED',
      }),
    );
    const errorSummary = summarizeActivationError(parseError);
    expect(errorSummary).toEqual(
      expect.objectContaining({
        class: 'provider_invalid_response',
        code: 'JSON_PARSE_FAILED',
      }),
    );
    expect(isActivationFallbackCandidate(parseError, errorSummary)).toBe(true);
    expect(
      activationProviderAttemptsUnavailable([
        {
          status: 'error',
          error: errorSummary,
        },
      ]),
    ).toBe(true);
  });

  test('rejects schema-invalid classifier JSON instead of coercing it into a decision', () => {
    for (const response of [
      '{}',
      '{"activate":"false","confidence":0.9,"reason":"wrong type"}',
      '{"activate":false,"confidence":"0.9","reason":"wrong type"}',
      '{"activate":true,"confidence":1.4,"reason":"out of range"}',
    ]) {
      expect(() => parseActivationResponse(response)).toThrow(
        expect.objectContaining({ code: 'JSON_VALIDATE_FAILED' }),
      );
    }

    expect(
      parseActivationResponse('{"should_activate":false,"confidence":0.91,"reason":"valid alias"}'),
    ).toEqual({ activate: false, confidence: 0.91, reason: 'valid alias' });
  });

  test('renders configured direct-action surfaces only when exact tools are attached', () => {
    const config = {
      viventium: {
        background_cortices: {
          activation_policy: {
            enabled: true,
            prompt: 'The main agent owns direct execution through connected tools.',
            direct_action_mcp_servers: [
              {
                server: 'glasshive-workers-projects',
                scope_key: 'host_workers',
                owns: 'persistent workers and local computer actions',
                tool_names: ['worker_run_mcp_glasshive-workers-projects'],
              },
              {
                server: 'scheduling-cortex',
                owns: 'scheduled follow-ups',
                tool_names: ['schedule_create_mcp_scheduling-cortex'],
              },
            ],
          },
        },
      },
    };
    const mainAgent = {
      tools: ['worker_run_mcp_glasshive-workers-projects', 'web_search'],
    };

    const result = buildActivationPolicySection({ config, mainAgent });

    expect(result.section).toContain('## Global Activation Policy:');
    expect(result.section).toContain('glasshive-workers-projects');
    expect(result.section).toContain('scope_key: host_workers');
    expect(result.section).not.toContain('scheduling-cortex');
    expect(result.connectedSurfaces).toEqual([
      expect.objectContaining({
        server: 'glasshive-workers-projects',
        scopeKey: 'host_workers',
      }),
    ]);
  });

  test('normalizes direct-action surface scopes for hold decisions', () => {
    expect(
      normalizeDirectActionSurfaceScopes([
        { server: 'Google', scope_key: 'Productivity Google Workspace' },
        { server: 'duplicate', scopeKey: 'productivity_google_workspace' },
        'Productivity MS365',
        null,
      ]),
    ).toEqual([
      {
        server: 'Google',
        scopeKey: 'productivity_google_workspace',
        owns: '',
        sameScopeBackgroundAllowed: false,
      },
      { scopeKey: 'productivity_ms365' },
    ]);
  });

  test('renders same-scope supplemental background contract for matching direct surfaces', () => {
    const result = buildActivationPolicySection({
      config: {
        viventium: {
          background_cortices: {
            activation_policy: {
              enabled: true,
              prompt: 'Policy text.',
              direct_action_mcp_servers: [
                {
                  server: 'google-workspace',
                  scope_key: 'productivity_google_workspace',
                  same_scope_background_allowed: true,
                  tool_names: ['search_gmail_messages_mcp_google_workspace'],
                },
              ],
            },
          },
        },
      },
      mainAgent: { tools: ['search_gmail_messages_mcp_google_workspace'] },
    });

    expect(result.section).toContain('same_scope_background_allowed: true');
    expect(result.section).toContain(
      'not as a blocker for a background agent whose own configured activation scope exactly matches',
    );
    expect(result.connectedSurfaces[0]).toEqual(
      expect.objectContaining({
        scopeKey: 'productivity_google_workspace',
        sameScopeBackgroundAllowed: true,
      }),
    );
  });

  test('structurally suppresses same-scope background activation unless supplemental Phase B is allowed', () => {
    expect(
      applyDirectActionOwnershipGate({
        shouldActivate: true,
        confidence: 0.91,
        reason: 'classifier_match',
        agentId: 'agent_productivity',
        activationScope: 'productivity_google_workspace',
        directActionSurfaceScopes: [
          {
            server: 'google-workspace',
            scopeKey: 'productivity_google_workspace',
            sameScopeBackgroundAllowed: false,
          },
        ],
      }),
    ).toEqual(
      expect.objectContaining({
        shouldActivate: false,
        reason: 'direct_action_owned_by_main_agent',
        suppressedByDirectActionOwnership: true,
      }),
    );

    expect(
      applyDirectActionOwnershipGate({
        shouldActivate: true,
        confidence: 0.91,
        reason: 'classifier_match',
        agentId: 'agent_productivity',
        activationScope: 'productivity_google_workspace',
        directActionSurfaceScopes: [
          {
            server: 'google-workspace',
            scopeKey: 'productivity_google_workspace',
            sameScopeBackgroundAllowed: true,
          },
        ],
      }),
    ).toEqual(
      expect.objectContaining({
        shouldActivate: true,
        reason: 'classifier_match',
      }),
    );
  });

  test('does not infer direct-action surfaces from undeclared tool-name suffixes', () => {
    const config = {
      viventium: {
        background_cortices: {
          activation_policy: {
            enabled: true,
            prompt: 'Policy text.',
            direct_action_mcp_servers: [
              {
                server: 'future-mcp',
                owns: 'future direct action',
                tool_names: ['future_action'],
              },
            ],
          },
        },
      },
    };
    const mainAgent = {
      tools: ['worker_run_mcp_glasshive-workers-projects'],
    };

    const result = buildActivationPolicySection({ config, mainAgent });

    expect(result.section).toContain('Policy text.');
    expect(result.section).not.toContain('future-mcp');
    expect(result.connectedSurfaces).toEqual([]);
  });

  test('renders the generic stricter activation policy without agent-name overfitting', () => {
    const policyPrompt = [
      'The main agent owns the current turn. Background agents are optional reviewers, not controllers.',
      "When this policy and this background agent's own activation criteria disagree, prefer the stricter outcome: do not activate.",
      'unless this same background agent received verified evidence in its own allowed context this turn.',
    ].join('\n\n');
    const config = {
      viventium: {
        background_cortices: {
          activation_policy: {
            enabled: true,
            prompt: policyPrompt,
          },
        },
      },
    };

    const result = buildActivationPolicySection({ config, mainAgent: { tools: [] } });

    expect(result.section).toContain('Background agents are optional reviewers, not controllers.');
    expect(result.section).toContain('prefer the stricter outcome: do not activate.');
    expect(result.section).toContain('verified evidence in its own allowed context');
    expect(result.section).not.toMatch(/emotional|user-help|product-help/i);
  });

  test('source-of-truth activation policy stays generic and agent-name agnostic', () => {
    const sourcePath = path.resolve(
      __dirname,
      '../../../../viventium/source_of_truth/local.librechat.yaml',
    );
    const source = resolvePromptRefs(yaml.load(fs.readFileSync(sourcePath, 'utf8')));
    const prompt = source?.viventium?.background_cortices?.activation_policy?.prompt || '';

    expect(prompt).toContain('Background agents are optional reviewers, not controllers.');
    expect(prompt).toContain('connected direct-action surface');
    expect(prompt).toContain('same_scope_background_allowed=true');
    expect(prompt).toContain('supplemental Phase B evidence');
    expect(prompt).toContain(
      'Return should_activate=true only when the latest request contains a separate explicit question or decision',
    );
    expect(prompt).toContain('If uncertain, return should_activate=false.');
    expect(prompt).not.toMatch(
      /Emotional Resonance|Confirmation Bias|Red Team|Pattern Recognition|Strategic Planning|Viventium User Help|Deep Research|product-help|user-help/i,
    );
  });

  test('resolves a source-owned activation policy promptRef without compiler preprocessing', () => {
    const sourcePath = path.resolve(
      __dirname,
      '../../../../viventium/source_of_truth/local.librechat.yaml',
    );
    const source = yaml.load(fs.readFileSync(sourcePath, 'utf8'));

    const result = buildActivationPolicySection({ config: source, mainAgent: { tools: [] } });

    expect(result.section).toContain('Connected direct-action surfaces are execution owners.');
    expect(result.section).not.toContain('[object Object]');
  });

  test('source-of-truth policy does not declare generic reasoning tools as direct-action blockers', () => {
    const sourcePath = path.resolve(
      __dirname,
      '../../../../viventium/source_of_truth/local.librechat.yaml',
    );
    const source = yaml.load(fs.readFileSync(sourcePath, 'utf8'));
    const directActionServers =
      source?.viventium?.background_cortices?.activation_policy?.direct_action_mcp_servers || [];
    const declaredTools = directActionServers.flatMap((server) => server.tool_names || []);

    expect(directActionServers.map((server) => server.server)).toEqual(
      expect.arrayContaining([
        'glasshive-workers-projects',
        'scheduling-cortex',
        'google-workspace',
        'ms365',
      ]),
    );
    expect(directActionServers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          server: 'google-workspace',
          scope_key: 'productivity_google_workspace',
        }),
        expect.objectContaining({ server: 'ms365', scope_key: 'productivity_ms365' }),
      ]),
    );
    expect(directActionServers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          server: 'google-workspace',
          same_scope_background_allowed: false,
        }),
        expect.objectContaining({ server: 'ms365', same_scope_background_allowed: false }),
      ]),
    );
    expect(declaredTools).not.toContain('web_search');
    expect(declaredTools).not.toContain('file_search');
    expect(declaredTools).not.toContain('sequential-thinking');
  });

  test('normalizes string and object tool declarations', () => {
    expect(
      normalizeAgentToolNames({
        tools: [
          'web_search',
          { name: 'worker_run_mcp_glasshive-workers-projects' },
          { id: 'schedule_create' },
        ],
      }),
    ).toEqual(['web_search', 'worker_run_mcp_glasshive-workers-projects', 'schedule_create']);
  });

  test('formats LangChain-style _getType messages for activation context', () => {
    expect(
      formatHistoryForActivation(
        [
          {
            _getType: () => 'human',
            content: 'Please let Red Team run visibly.',
          },
          {
            _getType: () => 'ai',
            content: 'Understood.',
          },
        ],
        5,
      ),
    ).toContain('[User] Please let Red Team run visibly.');
  });

  test('hydrates canonical server-side tools for activation policy when request agent is sparse', async () => {
    const requestAgent = {
      id: 'agent_main',
      provider: 'anthropic',
      tools: [],
      background_cortices: [{ agent_id: 'agent_google' }],
    };
    const canonicalAgent = {
      id: 'agent_main',
      tools: [
        'sys__server__sys_mcp_google_workspace',
        'search_gmail_messages_mcp_google_workspace',
        'get_events_mcp_google_workspace',
      ],
    };

    const hydrated = await resolveActivationPolicyMainAgent({
      req: { user: { id: 'user_1' } },
      mainAgent: requestAgent,
      timeoutMs: 50,
      loadAgentFn: jest.fn().mockResolvedValue(canonicalAgent),
    });

    expect(hydrated).toEqual(
      expect.objectContaining({
        id: 'agent_main',
        tools: canonicalAgent.tools,
      }),
    );
    expect(hydrated.background_cortices).toEqual(requestAgent.background_cortices);
  });

  test('counts event-driven cortex tool definitions before falling back to source tool strings', () => {
    expect(
      countConfiguredCortexTools(
        {
          tools: [],
          toolDefinitions: [
            { name: 'search_gmail_messages_mcp_google_workspace' },
            { name: 'get_gmail_message_content_mcp_google_workspace' },
            { name: 'search_gmail_messages_mcp_google_workspace' },
          ],
        },
        { tools: ['sys__server__sys_mcp_google_workspace'] },
      ),
    ).toBe(2);

    expect(
      countConfiguredCortexTools(
        { tools: [] },
        {
          tools: [
            'sys__server__sys_mcp_ms-365',
            'list-mail-messages_mcp_ms-365',
            'list-mail-messages_mcp_ms-365',
          ],
        },
      ),
    ).toBe(2);
  });

  test('suppresses empty and no-response cortex output', () => {
    expect(hasVisibleCortexInsight('')).toBe(false);
    expect(hasVisibleCortexInsight('   {NTA}   ')).toBe(false);
    expect(hasVisibleCortexInsight('Real insight with {NTA} mentioned in a sentence.')).toBe(true);
  });

  test('marks no-response cortex completion as terminal but silent', () => {
    expect(
      buildCortexCompletionPayload({
        agentId: 'agent_google',
        agentName: 'Google Workspace',
        insight: '{NTA}',
        activationScope: 'productivity_google_workspace',
        configuredTools: 12,
        completedToolCalls: 0,
        confidence: 0.91,
        reason: 'gmail_request',
        cortexDescription: 'Checks Google Workspace.',
      }),
    ).toEqual({
      cortex_id: 'agent_google',
      cortex_name: 'Google Workspace',
      status: 'complete',
      insight: '',
      silent: true,
      no_response: true,
      activation_scope: 'productivity_google_workspace',
      configured_tools: 12,
      completed_tool_calls: 0,
      confidence: 0.91,
      reason: 'gmail_request',
      cortex_description: 'Checks Google Workspace.',
    });
  });

  test('keeps visible cortex completion renderable', () => {
    expect(
      buildCortexCompletionPayload({
        agentId: 'agent_research',
        agentName: 'Deep Research',
        insight: 'Useful supporting evidence.',
      }),
    ).toEqual(
      expect.objectContaining({
        cortex_id: 'agent_research',
        status: 'complete',
        insight: 'Useful supporting evidence.',
        silent: false,
        no_response: false,
      }),
    );
  });

  test('preserves public fallback disclosure on cortex completion', () => {
    expect(
      buildCortexCompletionPayload({
        agentId: 'agent_research',
        agentName: 'Deep Research',
        insight: 'Useful fallback evidence.',
        fallbackUsed: true,
        primaryErrorClass: 'provider_unauthorized',
      }),
    ).toEqual(
      expect.objectContaining({
        status: 'complete',
        fallback_used: true,
        fallback_reason_class: 'provider_unauthorized',
      }),
    );
  });

  test('keeps terminal error completion metadata renderable', () => {
    expect(
      buildCortexCompletionPayload({
        agentId: 'agent_google',
        agentName: 'Google Workspace',
        error: 'timeout',
        activationScope: 'productivity_google_workspace',
        configuredTools: 12,
        completedToolCalls: 3,
        confidence: 0.91,
        reason: 'gmail_request',
        cortexDescription: 'Checks Google Workspace.',
        directActionSurfaceScopes: [
          {
            server: 'google-workspace',
            scopeKey: 'productivity_google_workspace',
            owns: 'Google Workspace',
            sameScopeBackgroundAllowed: true,
          },
        ],
      }),
    ).toEqual({
      cortex_id: 'agent_google',
      cortex_name: 'Google Workspace',
      status: 'error',
      error: 'This background agent timed out before returning a result.',
      error_class: 'timeout',
      activation_scope: 'productivity_google_workspace',
      configured_tools: 12,
      completed_tool_calls: 3,
      confidence: 0.91,
      reason: 'gmail_request',
      cortex_description: 'Checks Google Workspace.',
      direct_action_surface_scopes: [
        {
          server: 'google-workspace',
          scopeKey: 'productivity_google_workspace',
          owns: 'Google Workspace',
          sameScopeBackgroundAllowed: true,
        },
      ],
    });
  });

  test('classifies activation provider errors for actionable diagnostics', () => {
    expect(classifyActivationError({ status: 403, message: 'Access denied' })).toBe(
      'provider_access_denied',
    );
    expect(classifyActivationError({ status: 429, message: 'rate limit' })).toBe(
      'provider_rate_limited',
    );
    expect(
      summarizeActivationError({
        response: { status: 403 },
        code: 'ERR_BAD_REQUEST',
        message: 'Access denied',
      }),
    ).toEqual(
      expect.objectContaining({
        status: 403,
        class: 'provider_access_denied',
      }),
    );
  });

  test('temporarily suppresses unhealthy activation providers without prompt heuristics', () => {
    expect(
      markActivationProviderUnhealthy({
        provider: 'groq',
        model: 'qwen/qwen3.6-27b',
        errorSummary: {
          class: 'provider_access_denied',
          status: 403,
          code: 'ERR_BAD_REQUEST',
          message: 'Access denied',
        },
      }),
    ).toBe(true);

    expect(
      getActivationProviderSuppression({
        provider: 'Groq',
        model: 'qwen/qwen3.6-27b',
      }),
    ).toEqual(
      expect.objectContaining({
        provider: 'groq',
        model: 'qwen/qwen3.6-27b',
        error: expect.objectContaining({ class: 'provider_access_denied' }),
      }),
    );

    expect(
      markActivationProviderUnhealthy({
        provider: 'openai',
        model: 'gpt-5.4',
        errorSummary: { class: 'provider_error', message: 'generic bad response' },
      }),
    ).toBe(false);
  });

  test('scopes user-auth activation provider suppression to the affected user', () => {
    const privateEmail = ['user-one', 'example.com'].join('@');
    const errorSummary = {
      class: 'provider_access_denied',
      status: 403,
      code: 'ERR_BAD_REQUEST',
      message: `Access denied for account ${privateEmail}`,
    };

    expect(
      markActivationProviderUnhealthy({
        provider: 'openai',
        model: 'gpt-5.4',
        errorSummary,
        req: { user: { id: 'user-one' } },
      }),
    ).toBe(true);

    expect(
      getActivationProviderSuppression({
        provider: 'openai',
        model: 'gpt-5.4',
        req: { user: { id: 'user-one' } },
      }),
    ).toEqual(
      expect.objectContaining({
        scope: 'user:user-one',
        error: { class: 'provider_access_denied', status: 403, code: 'ERR_BAD_REQUEST' },
      }),
    );
    expect(
      getActivationProviderSuppression({
        provider: 'openai',
        model: 'gpt-5.4',
        req: { user: { id: 'user-two' } },
      }),
    ).toBeNull();
  });

  test('probes one stale auth-class activation suppression only when every attempt is suppressed', () => {
    const attempts = [
      { provider: 'groq', model: 'llama', source: 'primary' },
      { provider: 'openai', model: 'gpt-5.4', source: 'fallback' },
    ];

    expect(
      shouldProbeSuppressedActivationAttempt({
        attempts,
        allAttemptsSuppressed: true,
        probeAlreadyUsed: false,
        providerSuppression: {
          error: { class: 'provider_unauthorized' },
        },
      }),
    ).toBe(true);

    expect(
      shouldProbeSuppressedActivationAttempt({
        attempts,
        allAttemptsSuppressed: true,
        probeAlreadyUsed: true,
        providerSuppression: {
          error: { class: 'provider_unauthorized' },
        },
      }),
    ).toBe(false);

    expect(
      shouldProbeSuppressedActivationAttempt({
        attempts,
        allAttemptsSuppressed: false,
        probeAlreadyUsed: false,
        providerSuppression: {
          error: { class: 'provider_unauthorized' },
        },
      }),
    ).toBe(false);

    expect(
      shouldProbeSuppressedActivationAttempt({
        attempts,
        allAttemptsSuppressed: true,
        probeAlreadyUsed: false,
        providerSuppression: {
          error: { class: 'provider_rate_limited' },
        },
      }),
    ).toBe(false);

    expect(
      shouldProbeSuppressedActivationAttempt({
        attempts,
        allAttemptsSuppressed: true,
        probeAlreadyUsed: false,
        providerSuppression: {
          error: { class: 'provider_access_denied' },
        },
      }),
    ).toBe(false);
  });

  test('does not let health suppression skip the primary activation provider', () => {
    const providerSuppression = {
      error: { class: 'provider_network' },
      until: Date.now() + 60000,
    };

    expect(
      shouldAttemptSuppressedActivationProvider({
        attempt: { provider: 'groq', model: 'llama', source: 'primary' },
        providerSuppression,
      }),
    ).toBe(true);

    expect(
      shouldAttemptSuppressedActivationProvider({
        attempt: { provider: 'xai', model: 'grok', source: 'fallback' },
        providerSuppression,
      }),
    ).toBe(false);
  });

  test('surfaces configured terminal cards only from source-owned failure visibility policy', () => {
    const providerAttempts = [
      {
        provider: 'groq',
        model: 'llama',
        source: 'primary',
        status: 'error',
        error: { class: 'provider_access_denied', status: 403, code: 'ERR_BAD_REQUEST' },
      },
      {
        provider: 'openai',
        model: 'gpt-5.4',
        source: 'fallback',
        status: 'skipped_unhealthy',
        error: { class: 'provider_unauthorized', status: 401, code: null },
      },
    ];

    expect(activationProviderAttemptsUnavailable(providerAttempts)).toBe(true);
    expect(
      activationFailureVisibility({ activation: { activation_failure_visibility: 'visible' } }),
    ).toBe('visible');
    expect(
      activationFailureVisibility({
        activation: { activation_failure_visibility: 'anything_else' },
      }),
    ).toBe('silent');
    expect(
      shouldSurfaceActivationProviderUnavailable({
        activationResult: { providerAttempts },
        cortexConfig: { activation: { activation_failure_visibility: 'visible' } },
      }),
    ).toBe(true);
    expect(
      shouldSurfaceActivationProviderUnavailable({
        activationResult: { providerAttempts },
        cortexConfig: { activation: { activation_failure_visibility: 'silent' } },
      }),
    ).toBe(false);
    expect(
      shouldSurfaceActivationTimeout({
        activationResult: { reason: 'global_timeout' },
        cortexConfig: { activation: { activation_failure_visibility: 'visible' } },
      }),
    ).toBe(false);
    expect(configuredCortexDisplayName({ agent_id: 'agent_viventium_red_team_95aeb3' })).toBe(
      'Red Team',
    );
    expect(
      buildCortexCompletionPayload({
        agentId: 'agent_confirmation_bias',
        agentName: 'Confirmation Bias',
        error: 'activation_provider_unavailable',
        errorClass: 'activation_provider_unavailable',
        reason: 'activation_provider_unavailable',
      }),
    ).toEqual(
      expect.objectContaining({
        cortex_name: 'Confirmation Bias',
        status: 'error',
        error_class: 'activation_provider_unavailable',
        error:
          'This background agent could not start because every configured activation provider was unavailable.',
      }),
    );
  });

  test('cortex completion errors are public-safe before rendering', () => {
    const privateEmail = ['user-one', 'example.com'].join('@');
    const privatePath = '/' + ['Users', 'example', 'project'].join('/');
    const bearerSecret = ['Bearer', 'abcdefghijklmnopqrstuvwxyz'].join(' ');
    const payload = buildCortexCompletionPayload({
      agentId: 'agent_private',
      agentName: 'Private Agent',
      error: `Provider failed for ${privateEmail} at ${privatePath} with ${bearerSecret}`,
    });

    expect(payload).toEqual(
      expect.objectContaining({
        status: 'error',
        error_class: 'recoverable_provider_error',
        error: 'This background agent hit a recoverable provider issue before returning a result.',
      }),
    );
    expect(JSON.stringify(payload)).not.toContain(privatePath);
    expect(JSON.stringify(payload)).not.toContain(privateEmail);
    expect(JSON.stringify(payload)).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });

  test('expires unhealthy activation provider suppression after the configured ttl', () => {
    const previousTtl = process.env.VIVENTIUM_ACTIVATION_PROVIDER_HEALTH_TTL_MS;
    const nowSpy = jest.spyOn(Date, 'now');
    try {
      process.env.VIVENTIUM_ACTIVATION_PROVIDER_HEALTH_TTL_MS = '100';
      nowSpy.mockReturnValue(1000);

      expect(
        markActivationProviderUnhealthy({
          provider: 'groq',
          model: 'qwen/qwen3.6-27b',
          errorSummary: {
            class: 'provider_access_denied',
            status: 403,
            code: 'ERR_BAD_REQUEST',
            message: 'Access denied',
          },
        }),
      ).toBe(true);

      expect(
        getActivationProviderSuppression({
          provider: 'groq',
          model: 'qwen/qwen3.6-27b',
        }),
      ).toEqual(expect.objectContaining({ provider: 'groq' }));

      nowSpy.mockReturnValue(1101);
      expect(
        getActivationProviderSuppression({
          provider: 'groq',
          model: 'qwen/qwen3.6-27b',
        }),
      ).toBeNull();
    } finally {
      nowSpy.mockRestore();
      if (previousTtl == null) {
        delete process.env.VIVENTIUM_ACTIVATION_PROVIDER_HEALTH_TTL_MS;
      } else {
        process.env.VIVENTIUM_ACTIVATION_PROVIDER_HEALTH_TTL_MS = previousTtl;
      }
    }
  });

  test('removes unsupported sampling controls from OpenAI reasoning activation fallback', async () => {
    const llmConfig = await buildActivationLlmConfig({
      providerName: 'openai',
      model: 'gpt-5.4',
      req: null,
    });

    expect(llmConfig.temperature).toBeUndefined();
    expect(llmConfig.modelKwargs).toBeUndefined();
  });

  test('fails loudly when an activation provider cannot be resolved exactly', async () => {
    await expect(
      buildActivationLlmConfig({
        providerName: 'missing-provider',
        model: 'missing-model',
        req: { user: { id: 'user-test' }, config: { endpoints: { custom: [] } } },
      }),
    ).rejects.toThrow('Unsupported or unavailable activation provider');
  });

  test('uses config rather than provider-name literals for OpenAI-compatible activation transport', async () => {
    const llmConfig = await buildActivationLlmConfig({
      providerName: 'synthetic-openai-transport',
      model: 'synthetic-model',
      req: {
        config: {
          endpoints: {
            agents: {
              activationOpenAITransportProviders: ['synthetic-openai-transport'],
            },
            custom: [],
          },
        },
      },
    });

    expect(llmConfig.provider).toBe('openAI');
    expect(llmConfig.model).toBe('synthetic-model');
  });

  test('adds a bounded guard grace around each Phase B cortex attempt', () => {
    const previousTimeout = process.env.VIVENTIUM_CORTEX_EXECUTION_TIMEOUT_MS;
    const previous = process.env.VIVENTIUM_CORTEX_EXECUTION_GUARD_GRACE_MS;
    delete process.env.VIVENTIUM_CORTEX_EXECUTION_TIMEOUT_MS;
    expect(getCortexAttemptGuardTimeoutMs()).toBe(0);
    process.env.VIVENTIUM_CORTEX_EXECUTION_GUARD_GRACE_MS = '5000';
    expect(getCortexAttemptGuardTimeoutMs(1000)).toBe(6000);
    process.env.VIVENTIUM_CORTEX_EXECUTION_GUARD_GRACE_MS = '120000';
    expect(getCortexAttemptGuardTimeoutMs(1000)).toBe(61000);
    if (previous == null) {
      delete process.env.VIVENTIUM_CORTEX_EXECUTION_GUARD_GRACE_MS;
    } else {
      process.env.VIVENTIUM_CORTEX_EXECUTION_GUARD_GRACE_MS = previous;
    }
    if (previousTimeout == null) {
      delete process.env.VIVENTIUM_CORTEX_EXECUTION_TIMEOUT_MS;
    } else {
      process.env.VIVENTIUM_CORTEX_EXECUTION_TIMEOUT_MS = previousTimeout;
    }
  });

  test('scopes activation cooldowns to the request identity when message metadata is available', () => {
    const baseReq = {
      user: { id: 'user_1' },
      body: {
        conversationId: 'new',
        messageId: 'message_calendar',
      },
    };

    expect(
      buildActivationCooldownKey({
        agentId: 'agent_productivity',
        req: baseReq,
        runId: 'run_1',
      }),
    ).toBe('agent_productivity:user_1:message_calendar');

    expect(
      buildActivationCooldownKey({
        agentId: 'agent_productivity',
        req: {
          ...baseReq,
          body: {
            conversationId: 'new',
            messageId: 'message_email',
          },
        },
        runId: 'run_2',
      }),
    ).toBe('agent_productivity:user_1:message_email');

    expect(
      buildActivationCooldownKey({
        agentId: 'agent_productivity',
        req: {
          user: { id: 'user_1' },
          body: {
            conversationId: 'conversation_1',
            messageId: 'message_1',
          },
        },
        runId: 'run_3',
      }),
    ).toBe('agent_productivity:user_1:conversation_1:message_1');

    expect(
      buildActivationCooldownKey({
        agentId: 'agent_productivity',
        req: {
          user: { id: 'user_1' },
          body: {
            conversationId: 'new',
          },
        },
        runId: 'run_4',
      }),
    ).toBe('agent_productivity:user_1:run_4');
  });

  test('builds validated OpenAI fallback agent for background cortex execution', async () => {
    const fallbackAgent = await resolveBackgroundCortexFallbackAgent({
      req: {
        config: {
          endpoints: {
            agents: {
              allowedProviders: ['anthropic', 'openAI'],
            },
          },
        },
      },
      modelsConfig: {
        openAI: ['gpt-5.4'],
      },
      cortexAgent: {
        id: 'agent_viventium_confirmation_bias_95aeb3',
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        model_parameters: {
          model: 'claude-sonnet-4-5',
          thinking: false,
        },
        fallback_llm_provider: 'openAI',
        fallback_llm_model: 'gpt-5.4',
        fallback_llm_model_parameters: {
          model: 'gpt-5.4',
          reasoning_effort: 'high',
        },
      },
    });

    expect(fallbackAgent).toEqual(
      expect.objectContaining({
        provider: 'openAI',
        model: 'gpt-5.4',
        endpoint: undefined,
      }),
    );
    expect(fallbackAgent.model_parameters).toEqual({
      model: 'gpt-5.4',
      reasoning_effort: 'high',
    });
  });

  test('preserves capability-declared high effort for a GlassHive background fallback', async () => {
    const fallbackAgent = await resolveBackgroundCortexFallbackAgent({
      req: {
        config: {
          endpoints: {
            agents: {
              allowedProviders: ['openAI', 'glasshive-harness'],
              providerCapabilities: {
                'glasshive-harness': {
                  automatic_fallback_target: true,
                  models: [
                    {
                      id: 'claude-code:opus',
                      effortChoices: ['low', 'medium', 'high', 'xhigh', 'max'],
                    },
                  ],
                },
              },
            },
          },
        },
      },
      modelsConfig: {
        'glasshive-harness': ['claude-code:opus'],
      },
      cortexAgent: {
        id: 'agent_viventium_confirmation_bias_95aeb3',
        provider: 'openAI',
        model: 'gpt-5.6-sol',
        model_parameters: { model: 'gpt-5.6-sol' },
        fallback_llm_provider: 'glasshive-harness',
        fallback_llm_model: 'claude-code:opus',
        fallback_llm_model_parameters: {
          model: 'claude-code:opus',
          reasoning_effort: 'high',
        },
      },
    });

    expect(fallbackAgent).toMatchObject({
      provider: 'glasshive-harness',
      model: 'claude-code:opus',
      model_parameters: {
        model: 'claude-code:opus',
        reasoning_effort: 'high',
      },
    });
  });
});

describe('native structured cortex failures', () => {
  test.each([
    [503, 'host_capacity', 'host_capacity'],
    [401, 'invalid_api_key', 'provider_unauthorized'],
    [403, 'permission_denied', 'provider_access_denied'],
    [400, 'invalid_request', 'provider_request_rejected'],
    [503, 'service_unavailable', 'provider_unavailable'],
  ])('keeps native status %s and code %s distinct', (status, code, expectedClass) => {
    const error = { status, error: { detail: { code, message: 'Structured failure.' } } };
    expect(extractCortexErrorCode(error)).toBe(code);
    expect(classifyCortexPublicError(error)).toBe(expectedClass);
  });
  test('prefers native detail code to a generic transport wrapper', () => {
    expect(
      extractCortexErrorCode({
        code: 'ERR_BAD_RESPONSE',
        response: { data: { detail: { code: 'host_capacity' } } },
      }),
    ).toBe('host_capacity');
  });
});
// VIVENTIUM END
