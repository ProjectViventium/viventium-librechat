/* === VIVENTIUM START === MPV-061 production Voice trace contract tests. === VIVENTIUM END === */

const mockRecordOrchestrationTraceEvent = jest.fn();
const mockOrchestrationRuntimeTraceBinding = jest.fn();

jest.mock('../OrchestrationTraceLedgerService', () => ({
  recordOrchestrationTraceEvent: (...args) => mockRecordOrchestrationTraceEvent(...args),
}));

jest.mock('../ViventiumOrchestrationMode', () => ({
  orchestrationRuntimeTraceBinding: (...args) => mockOrchestrationRuntimeTraceBinding(...args),
}));

const {
  VOICE_TRACE_STAGE_PLANES,
  currentVoiceOrchestrationTraceBinding,
  recordVoiceOrchestrationTrace,
  recordVoiceOrchestrationTraceBestEffort,
} = require('../VoiceOrchestrationTraceService');

const CANDIDATE = {
  contractVersion: 1,
  candidateDigest: `sha256:${'1'.repeat(64)}`,
  installedArtifactDigest: `sha256:${'2'.repeat(64)}`,
  runtimeOwnerBindingHash: `sha256:${'3'.repeat(64)}`,
};

describe('VoiceOrchestrationTraceService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockOrchestrationRuntimeTraceBinding.mockReturnValue(CANDIDATE);
    mockRecordOrchestrationTraceEvent.mockImplementation(async (input) => input);
  });

  test('publishes every MPV-061 production stage through the owner-scoped ledger', async () => {
    const stages = {
      'action.accepted': 'control',
      'control.completed': 'control',
      'tool.completed': 'tool',
      'controller.completed': 'controller',
      'cortex.completed': 'cortex',
      'live_memory.completed': 'liveMemory',
      'recall.completed': 'recall',
      'title_model.completed': 'titleModel',
      'response.completed': 'response',
      'tts.completed': 'tts',
      'audio.completed': 'audio',
      'provider.attempt.completed': 'provider',
      'provider.fallback.completed': 'provider',
      'provider.request.forwarded': 'provider',
      'attempt.history.complete': 'provider',
    };
    expect(VOICE_TRACE_STAGE_PLANES).toEqual(stages);

    for (const [index, stage] of Object.keys(stages).entries()) {
      await recordVoiceOrchestrationTrace({
        ownerId: 'owner-private',
        callSessionId: 'call-private',
        turnId: 'turn-private',
        eventRef: `event-private-${index}`,
        stage,
        ...(stage === 'attempt.history.complete'
          ? {
              facts: {
                state: 'failed',
                providerStatus: 'failed',
                attemptRole: 'primary',
                provider: 'fixture-provider',
                model: 'fixture-model',
                failure: 'provider_temporarily_unavailable',
                preModel: true,
                primaryStartedCount: 0,
                primaryCompletedCount: 0,
                providerHealthMutationCount: 0,
                providerHealthSuppressed: false,
              },
            }
          : {}),
      });
    }

    expect(mockRecordOrchestrationTraceEvent).toHaveBeenCalledTimes(Object.keys(stages).length);
    expect(mockRecordOrchestrationTraceEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        ownerId: 'owner-private',
        originRef: 'voice:call-private',
        eventKey: 'voice:action.accepted:call-private:turn-private:event-private-0',
        stage: 'action.accepted',
        facts: expect.objectContaining({
          callSessionRef: 'call-private',
          logicalTurnRef: 'turn-private',
          sourceEventRef: 'event-private-0',
          candidateDigest: CANDIDATE.candidateDigest,
          installedArtifactDigest: CANDIDATE.installedArtifactDigest,
          runtimeOwnerBindingHash: CANDIDATE.runtimeOwnerBindingHash,
          effectPlane: 'control',
          outcome: 'accepted',
        }),
      }),
    );
  });

  test('exposes only the validated current installed runtime binding', () => {
    expect(currentVoiceOrchestrationTraceBinding()).toEqual(CANDIDATE);
    mockOrchestrationRuntimeTraceBinding.mockReturnValueOnce(null);
    expect(() => currentVoiceOrchestrationTraceBinding()).toThrow(
      'voice_trace_runtime_binding_unavailable',
    );
  });

  test('encodes the exact controlled primary pre-model failure into typed trace facts', async () => {
    await recordVoiceOrchestrationTrace({
      ownerId: 'owner-private',
      callSessionId: 'call-private',
      turnId: 'turn-private',
      eventRef: 'control-private',
      stage: 'attempt.history.complete',
      facts: {
        attemptRef: 'primary-attempt',
        receiptRef: 'private-receipt',
        attemptNumber: 1,
        provider: 'xai',
        model: 'grok-4.5',
        state: 'failed',
        providerStatus: 'failed',
        attemptRole: 'primary',
        failure: 'provider_temporarily_unavailable',
        preModel: true,
        primaryStartedCount: 0,
        primaryCompletedCount: 0,
        providerHealthMutationCount: 0,
        providerHealthSuppressed: false,
        effectCount: 1,
      },
    });

    expect(mockRecordOrchestrationTraceEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'attempt.history.complete',
        facts: expect.objectContaining({
          state: 'failed',
          providerStatus: 'failed',
          attemptRole: 'primary',
          producerAttemptHistoryHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        }),
      }),
    );
    const facts = mockRecordOrchestrationTraceEvent.mock.calls[0][0].facts;
    expect(facts).not.toHaveProperty('failure');
    expect(facts).not.toHaveProperty('preModel');
    expect(facts).not.toHaveProperty('primaryStartedCount');
    expect(facts).not.toHaveProperty('primaryCompletedCount');
    expect(facts).not.toHaveProperty('providerHealthMutationCount');
    expect(facts).not.toHaveProperty('providerHealthSuppressed');
  });

  test('caller cannot replace server-resolved candidate or binding facts', async () => {
    await expect(
      recordVoiceOrchestrationTrace({
        ownerId: 'owner-private',
        callSessionId: 'call-private',
        turnId: 'turn-private',
        eventRef: 'event-private',
        stage: 'response.completed',
        facts: { candidateDigest: `sha256:${'f'.repeat(64)}` },
      }),
    ).rejects.toThrow('voice_trace_reserved_fact');
    expect(mockRecordOrchestrationTraceEvent).not.toHaveBeenCalled();
  });

  test.each([
    ['ownerId', ''],
    ['callSessionId', ''],
    ['turnId', ''],
    ['eventRef', ''],
    ['stage', 'private.stage'],
  ])('rejects missing or invalid %s before the ledger', async (field, value) => {
    await expect(
      recordVoiceOrchestrationTrace({
        ownerId: 'owner-private',
        callSessionId: 'call-private',
        turnId: 'turn-private',
        eventRef: 'event-private',
        stage: 'response.completed',
        [field]: value,
      }),
    ).rejects.toThrow(/^voice_trace_/);
    expect(mockRecordOrchestrationTraceEvent).not.toHaveBeenCalled();
  });

  test('fails closed when the active installed candidate cannot be proven', async () => {
    mockOrchestrationRuntimeTraceBinding.mockReturnValue(null);
    await expect(
      recordVoiceOrchestrationTrace({
        ownerId: 'owner-private',
        callSessionId: 'call-private',
        turnId: 'turn-private',
        eventRef: 'event-private',
        stage: 'response.completed',
      }),
    ).rejects.toThrow('voice_trace_runtime_binding_unavailable');
    expect(mockRecordOrchestrationTraceEvent).not.toHaveBeenCalled();
  });

  test('best-effort producer path cannot break the completed user operation', async () => {
    mockRecordOrchestrationTraceEvent.mockRejectedValueOnce(
      Object.assign(new Error('database unavailable'), { code: 'trace_store_unavailable' }),
    );
    await expect(
      recordVoiceOrchestrationTraceBestEffort({
        ownerId: 'owner-private',
        callSessionId: 'call-private',
        turnId: 'turn-private',
        eventRef: 'event-private',
        stage: 'response.completed',
      }),
    ).resolves.toBeNull();
  });
});
