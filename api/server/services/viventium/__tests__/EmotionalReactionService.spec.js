jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { buildFeelingCapsule, createDefaultFeelingBands } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const {
  buildEmotionalReactionAgent,
  buildEmotionalReactionInput,
  feelingStimulusKey,
  runEmotionalReaction,
  scheduleEmotionalReaction,
} = require('../EmotionalReactionService');

function snapshot(overrides = {}) {
  const bands = createDefaultFeelingBands(new Date('2026-07-09T12:00:00.000Z'));
  return {
    available: true,
    enabled: true,
    agentScope: 'all_agents',
    version: 3,
    asOf: '2026-07-09T12:00:00.000Z',
    bands,
    capsule: buildFeelingCapsule({ enabled: true, bands }),
    snapshotHash: 'snapshot-3',
    reactionInstruction: 'Prefer small natural changes.',
    reactionActivationMode: 'always',
    innerState: null,
    trail: [],
    reactionHealth: { status: 'never' },
    ...overrides,
  };
}

function reactionInsight(changes = [], innerState = 'I feel steady and present in this moment.') {
  return JSON.stringify({ changes, innerState });
}

function depsFor(state, insight = reactionInsight()) {
  return {
    now: jest.fn(() => new Date('2026-07-09T12:00:01.000Z')),
    getFeelingState: jest.fn(async () => ({
      enabled: state.enabled,
      version: state.version,
      bands: state.bands,
      reactionInstruction: state.reactionInstruction,
      reactionActivationMode: state.reactionActivationMode,
      trail: state.trail,
      reactionHealth: state.reactionHealth,
      processedStimulusKeys: [],
    })),
    updateFeelingState: jest.fn(async () => ({ version: state.version + 1 })),
    commitFeelingReaction: jest.fn(async () => ({ version: state.version + 1 })),
    updateFeelingReactionHealth: jest.fn(async () => ({})),
    executeCortex: jest.fn(async () => ({ insight })),
    checkCortexActivation: jest.fn(async () => ({
      shouldActivate: true,
      confidence: 0.9,
      reason: 'relevant',
    })),
  };
}

describe('EmotionalReactionService', () => {
  test('builds the approved GPT-5.6 Fast worker and includes only the external stimulus', () => {
    const state = snapshot({
      innerState: {
        text: 'A prior felt sentence must not feed the next appraisal.',
        generatedAt: '2026-07-09T11:59:00.000Z',
      },
    });
    const config = {
      reaction: {
        provider: 'openai',
        model: 'gpt-5.6-terra',
        useResponsesApi: true,
        reasoningEffort: 'none',
        serviceTier: 'priority',
        fallbackProvider: 'anthropic',
        fallbackModel: 'claude-haiku-4-5',
      },
    };
    const agent = buildEmotionalReactionAgent(config, state);
    expect(agent.instructions).not.toContain('manual_adjustment');
    expect(agent.instructions).not.toContain('reset_to_nature');
    expect(agent.instructions).not.toContain('smallest accurate strength');
    expect(agent.instructions).toContain('Slight means a subtle but real movement');
    expect(agent.instructions).toContain('Clear means an unmistakable movement');
    expect(agent.instructions).toContain('Strong means a pronounced movement');
    expect(agent.instructions).toContain('Do not default to slight');
    expect(agent.model_parameters).toEqual(
      expect.objectContaining({
        model: 'gpt-5.6-terra',
        useResponsesApi: true,
        reasoning_effort: 'none',
        service_tier: 'priority',
        response_format: { type: 'json_object' },
        max_output_tokens: 512,
      }),
    );
    expect(agent).toEqual(
      expect.objectContaining({
        fallback_llm_provider: 'anthropic',
        fallback_llm_model: 'claude-haiku-4-5',
        fallback_llm_model_parameters: {
          model: 'claude-haiku-4-5',
          max_output_tokens: 512,
        },
      }),
    );
    const input = JSON.parse(buildEmotionalReactionInput(state, 'This is the user stimulus.'));
    expect(input.latestExternalUserStimulus).toBe('This is the user stimulus.');
    expect(JSON.stringify(input)).not.toContain('assistantResponse');
    expect(JSON.stringify(input)).not.toContain('prior felt sentence');
    expect(input.currentState.care).toEqual(
      expect.objectContaining({ current: 74, nature: 74, halfLifeMinutes: 1440 }),
    );
  });

  test('always mode skips the classifier, applies typed operations, and writes health', async () => {
    const state = snapshot();
    const deps = depsFor(
      state,
      reactionInsight(
        [{ band: 'curiosity', direction: 'up', strength: 'clear', cause: 'new_information' }],
        'I feel newly intrigued and pulled toward what I have not understood yet.',
      ),
    );
    const result = await runEmotionalReaction(
      {
        req: { user: { id: 'user-1' }, body: {} },
        userText: 'I found something surprising.',
        stimulusId: 'message-1',
        scheduledSnapshot: state,
      },
      deps,
    );
    expect(result).toEqual({
      status: 'healthy',
      changedBandIds: ['curiosity'],
      operations: 1,
      innerStateUpdated: true,
    });
    expect(deps.checkCortexActivation).not.toHaveBeenCalled();
    expect(deps.executeCortex).toHaveBeenCalledWith(
      expect.objectContaining({ contextMode: 'minimal', executionTimeoutMs: expect.any(Number) }),
    );
    expect(deps.executeCortex.mock.calls[0][0].executionTimeoutMs).toBeLessThanOrEqual(15000);
    expect(deps.commitFeelingReaction).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        expectedVersion: 3,
        stimulusKey: feelingStimulusKey('message-1'),
        set: {
          'bands.curiosity': expect.objectContaining({ current: 74 }),
          innerState: expect.objectContaining({
            text: 'I feel newly intrigued and pulled toward what I have not understood yet.',
            generatedAt: expect.any(Date),
          }),
        },
        trailEntries: [
          expect.objectContaining({
            band: 'curiosity',
            direction: 'up',
            strength: 'clear',
            cause: 'new_information',
            sourceType: 'user_turn',
          }),
        ],
      }),
    );
    expect(deps.commitFeelingReaction).toHaveBeenLastCalledWith(
      expect.objectContaining({
        health: expect.objectContaining({
          status: 'healthy',
          requestedModel: 'gpt-5.6-terra',
          requestedServiceTier: 'priority',
          lastUsedServiceTier: 'priority',
        }),
      }),
    );
    const chunks = logger.info.mock.calls
      .map(([, envelope]) => envelope)
      .filter((envelope) => envelope && typeof envelope === 'object');
    const writeStart = chunks.find((envelope) => envelope.event === 'feelings.reaction.write');
    expect(writeStart).toBeDefined();
    const writeEvent = Object.assign(
      {},
      ...chunks.filter((envelope) => envelope.i === writeStart.i),
    );
    expect(writeEvent.strengthCounts).toEqual({ clear: 1 });
    expect(writeEvent.absoluteDeltaCounts).toEqual({ 8: 1 });
    expect(writeEvent).not.toHaveProperty('userText');
  });

  test('classified mode reuses activation detection and can skip the model call', async () => {
    const state = snapshot({ reactionActivationMode: 'classified' });
    const deps = depsFor(state);
    deps.checkCortexActivation.mockResolvedValue({
      shouldActivate: false,
      confidence: 0.1,
      reason: 'The private user message says they need a medical CSV.',
    });
    const result = await runEmotionalReaction(
      {
        req: { user: { id: 'user-1' }, body: {} },
        userText: 'Format this as CSV.',
        stimulusId: 'message-2',
        scheduledSnapshot: state,
      },
      deps,
    );
    expect(result).toEqual({ status: 'skipped', reason: 'not_activated' });
    expect(deps.checkCortexActivation).toHaveBeenCalledTimes(1);
    expect(deps.executeCortex).not.toHaveBeenCalled();
    expect(deps.updateFeelingReactionHealth).toHaveBeenLastCalledWith(
      expect.objectContaining({
        health: expect.objectContaining({ lastSkipReason: 'not_activated' }),
      }),
    );
  });

  test('rebases typed deltas without overwriting a manual edit made while running', async () => {
    const state = snapshot();
    const deps = depsFor(
      state,
      reactionInsight([
        { band: 'energy', direction: 'down', strength: 'slight', cause: 'fatigue' },
      ]),
    );
    const manuallyEdited = {
      ...state,
      version: 4,
      bands: {
        ...state.bands,
        energy: { ...state.bands.energy, current: 90 },
      },
    };
    deps.getFeelingState
      .mockResolvedValueOnce({ ...state, processedStimulusKeys: [] })
      .mockResolvedValue({ ...manuallyEdited, processedStimulusKeys: [] });
    const result = await runEmotionalReaction(
      {
        req: { user: { id: 'user-1' }, body: {} },
        userText: 'A tiring request.',
        stimulusId: 'message-3',
        scheduledSnapshot: state,
      },
      deps,
    );
    expect(result).toEqual({
      status: 'healthy',
      changedBandIds: ['energy'],
      operations: 1,
      innerStateUpdated: false,
    });
    const committed = deps.commitFeelingReaction.mock.calls[0][0];
    expect(committed.expectedVersion).toBe(4);
    expect(committed.set['bands.energy'].current).toBeCloseTo(87, 2);
    expect(committed.set).not.toHaveProperty('innerState');
  });

  test('records malformed model output as degraded without changing bands', async () => {
    const state = snapshot();
    const deps = depsFor(state, 'I think curiosity should rise.');
    const result = await runEmotionalReaction(
      {
        req: { user: { id: 'user-1' }, body: {} },
        userText: 'A stimulus.',
        stimulusId: 'message-4',
        scheduledSnapshot: state,
      },
      deps,
    );
    expect(result).toEqual({ status: 'degraded', errorClass: 'invalid_output' });
    expect(deps.executeCortex).toHaveBeenCalledTimes(2);
    expect(deps.commitFeelingReaction).not.toHaveBeenCalled();
    expect(deps.updateFeelingReactionHealth).toHaveBeenLastCalledWith(
      expect.objectContaining({
        health: expect.objectContaining({ status: 'degraded', lastErrorClass: 'invalid_output' }),
      }),
    );
  });

  test('recovers from one malformed response inside the detached reaction budget', async () => {
    const state = snapshot();
    const deps = depsFor(state);
    deps.executeCortex.mockResolvedValueOnce({ insight: 'not json' }).mockResolvedValueOnce({
      insight: reactionInsight([
        { band: 'drive', direction: 'up', strength: 'slight', cause: 'progress' },
      ]),
    });

    const result = await runEmotionalReaction(
      {
        req: { user: { id: 'user-1' }, body: {} },
        userText: 'I committed to the work.',
        stimulusId: 'message-retry',
        scheduledSnapshot: state,
      },
      deps,
    );

    expect(result).toEqual({
      status: 'healthy',
      changedBandIds: ['drive'],
      operations: 1,
      innerStateUpdated: true,
    });
    expect(deps.executeCortex).toHaveBeenCalledTimes(2);
    expect(deps.executeCortex.mock.calls[1][0].executionTimeoutMs).toBeLessThanOrEqual(15000);
    expect(deps.executeCortex.mock.calls[1][0].messages).toHaveLength(2);
  });

  test('retries one transient model timeout without blocking the visible reply path', async () => {
    const state = snapshot();
    const deps = depsFor(state);
    deps.executeCortex
      .mockResolvedValueOnce({ insight: '', errorClass: 'timeout' })
      .mockResolvedValueOnce({
        insight: reactionInsight([
          { band: 'play', direction: 'up', strength: 'slight', cause: 'playful_exchange' },
        ]),
      });

    const result = await runEmotionalReaction(
      {
        req: { user: { id: 'user-1' }, body: {} },
        userText: 'I am giggling with you.',
        stimulusId: 'message-timeout-retry',
        scheduledSnapshot: state,
      },
      deps,
    );

    expect(result).toEqual({
      status: 'healthy',
      changedBandIds: ['play'],
      operations: 1,
      innerStateUpdated: true,
    });
    expect(deps.executeCortex).toHaveBeenCalledTimes(2);
    expect(deps.executeCortex.mock.calls[0][0].executionTimeoutMs).toBeLessThanOrEqual(15000);
    expect(deps.executeCortex.mock.calls[1][0].executionTimeoutMs).toBeLessThanOrEqual(15000);
  });

  test('records the actual recovery route when the primary model falls back', async () => {
    const state = snapshot();
    const deps = depsFor(state);
    deps.executeCortex.mockResolvedValue({
      insight: `\`\`\`json\n${reactionInsight([{ band: 'care', direction: 'up', strength: 'slight', cause: 'care_signal' }])}\n\`\`\``,
      fallbackUsed: true,
      fallbackProvider: 'anthropic',
      fallbackModel: 'claude-haiku-4-5',
      primaryErrorClass: 'timeout',
    });

    const result = await runEmotionalReaction(
      {
        req: { user: { id: 'user-1' }, body: {} },
        userText: 'I am here for you.',
        stimulusId: 'message-fallback',
        scheduledSnapshot: state,
      },
      deps,
    );

    expect(result).toEqual({
      status: 'healthy',
      changedBandIds: ['care'],
      operations: 1,
      innerStateUpdated: true,
    });
    expect(deps.commitFeelingReaction).toHaveBeenLastCalledWith(
      expect.objectContaining({
        health: expect.objectContaining({
          requestedModel: 'gpt-5.6-terra',
          lastFallbackUsed: true,
          lastUsedProvider: 'anthropic',
          lastUsedModel: 'claude-haiku-4-5',
          lastUsedServiceTier: null,
          lastPrimaryErrorClass: 'timeout',
        }),
      }),
    );
  });

  test('deduplicates the same user/stimulus reaction while it is in flight', async () => {
    const state = snapshot();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const deps = depsFor(state);
    deps.executeCortex.mockImplementation(async () => {
      await gate;
      return { insight: reactionInsight() };
    });
    const params = {
      req: { user: { id: 'user-1' }, body: {} },
      userText: 'One turn.',
      stimulusId: 'message-5',
      scheduledSnapshot: state,
    };
    const first = scheduleEmotionalReaction(params, deps);
    const second = scheduleEmotionalReaction(params, deps);
    expect(second).toBe(first);
    release();
    await first;
    expect(deps.executeCortex).toHaveBeenCalledTimes(1);
  });

  test('deduplicates a completed stimulus from persisted state', async () => {
    const state = snapshot();
    const deps = depsFor(state);
    deps.getFeelingState.mockResolvedValue({
      ...state,
      processedStimulusKeys: [feelingStimulusKey('message-complete')],
    });

    const result = await runEmotionalReaction(
      {
        req: { user: { id: 'user-1' }, body: {} },
        userText: 'Already handled.',
        stimulusId: 'message-complete',
        scheduledSnapshot: state,
      },
      deps,
    );

    expect(result).toEqual({ status: 'skipped', reason: 'already_processed' });
    expect(deps.executeCortex).not.toHaveBeenCalled();
  });

  test('serializes different stimuli for the same user', async () => {
    const state = snapshot();
    const deps = depsFor(state);
    let releaseFirst;
    let firstStarted;
    const firstGate = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    const started = new Promise((resolve) => {
      firstStarted = resolve;
    });
    deps.executeCortex
      .mockImplementationOnce(async () => {
        firstStarted();
        await firstGate;
        return { insight: reactionInsight() };
      })
      .mockResolvedValue({ insight: reactionInsight() });

    const first = scheduleEmotionalReaction(
      {
        req: { user: { id: 'queue-user' }, body: {} },
        userText: 'First.',
        stimulusId: 'queue-1',
        scheduledSnapshot: state,
      },
      deps,
    );
    const second = scheduleEmotionalReaction(
      {
        req: { user: { id: 'queue-user' }, body: {} },
        userText: 'Second.',
        stimulusId: 'queue-2',
        scheduledSnapshot: state,
      },
      deps,
    );

    await started;
    expect(deps.executeCortex).toHaveBeenCalledTimes(1);
    releaseFirst();
    await Promise.all([first, second]);
    expect(deps.executeCortex).toHaveBeenCalledTimes(2);
  });

  test('retries an atomic reaction commit on a cross-process version race', async () => {
    const state = snapshot();
    const versionFour = { ...state, version: 4, processedStimulusKeys: [] };
    const deps = depsFor(
      state,
      reactionInsight([
        { band: 'play', direction: 'up', strength: 'slight', cause: 'playful_exchange' },
      ]),
    );
    let readCount = 0;
    deps.getFeelingState.mockImplementation(async () => {
      readCount += 1;
      return readCount <= 2 ? { ...state, processedStimulusKeys: [] } : versionFour;
    });
    deps.commitFeelingReaction.mockResolvedValueOnce(null).mockResolvedValueOnce({ version: 5 });

    const result = await runEmotionalReaction(
      {
        req: { user: { id: 'user-race' }, body: {} },
        userText: 'A playful turn.',
        stimulusId: 'message-race',
        scheduledSnapshot: state,
      },
      deps,
    );

    expect(result.status).toBe('healthy');
    expect(deps.commitFeelingReaction.mock.calls.map(([call]) => call.expectedVersion)).toEqual([
      3, 4,
    ]);
  });
});
