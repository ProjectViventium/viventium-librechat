import {
  createVoiceOrchestrationTraceService,
  VOICE_TRACE_STAGE_PLANES,
} from './voiceOrchestrationTrace';

const BINDING = {
  contractVersion: 1,
  candidateDigest: `sha256:${'1'.repeat(64)}`,
  installedArtifactDigest: `sha256:${'2'.repeat(64)}`,
  runtimeOwnerBindingHash: `sha256:${'3'.repeat(64)}`,
};

function dependencies() {
  return {
    logger: { warn: jest.fn() },
    recordOrchestrationTraceEvent: jest.fn(async (input) => input),
    orchestrationRuntimeTraceBinding: jest.fn(() => BINDING),
  };
}

describe('Voice orchestration trace producer', () => {
  it('publishes each declared stage with server-owned binding facts', async () => {
    const deps = dependencies();
    const service = createVoiceOrchestrationTraceService(deps);
    await service.recordVoiceOrchestrationTrace({
      ownerId: 'owner-1',
      callSessionId: 'call-1',
      turnId: 'turn-1',
      eventRef: 'event-1',
      stage: 'action.accepted',
    });

    expect(VOICE_TRACE_STAGE_PLANES['action.accepted']).toBe('control');
    expect(deps.recordOrchestrationTraceEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        originRef: 'voice:call-1',
        eventKey: 'voice:action.accepted:call-1:turn-1:event-1',
        facts: expect.objectContaining({
          candidateDigest: BINDING.candidateDigest,
          effectPlane: 'control',
          outcome: 'accepted',
        }),
      }),
    );
  });

  it('rejects reserved caller facts and an unproven runtime binding', async () => {
    const deps = dependencies();
    const service = createVoiceOrchestrationTraceService(deps);
    await expect(
      service.recordVoiceOrchestrationTrace({
        ownerId: 'owner-1',
        callSessionId: 'call-1',
        turnId: 'turn-1',
        eventRef: 'event-1',
        stage: 'response.completed',
        facts: { candidateDigest: `sha256:${'f'.repeat(64)}` },
      }),
    ).rejects.toThrow('voice_trace_reserved_fact');

    deps.orchestrationRuntimeTraceBinding.mockReturnValueOnce(null as never);
    expect(() => service.currentVoiceOrchestrationTraceBinding()).toThrow(
      'voice_trace_runtime_binding_unavailable',
    );
  });

  it('encodes the controlled pre-model failure without retaining raw failure controls', async () => {
    const deps = dependencies();
    const service = createVoiceOrchestrationTraceService(deps);
    await service.recordVoiceOrchestrationTrace({
      ownerId: 'owner-1',
      callSessionId: 'call-1',
      turnId: 'turn-1',
      eventRef: 'event-1',
      stage: 'attempt.history.complete',
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
    });
    const facts = (
      deps.recordOrchestrationTraceEvent.mock.calls[0][0] as { facts: Record<string, unknown> }
    ).facts;
    expect(facts.producerAttemptHistoryHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(facts).not.toHaveProperty('failure');
    expect(facts).not.toHaveProperty('preModel');
  });

  it('best-effort failure logs only bounded structural diagnostics', async () => {
    const deps = dependencies();
    deps.recordOrchestrationTraceEvent.mockRejectedValueOnce(
      Object.assign(new Error('/private/path and bearer secret'), {
        code: 'trace_store_unavailable',
      }),
    );
    const service = createVoiceOrchestrationTraceService(deps);
    await expect(
      service.recordVoiceOrchestrationTraceBestEffort({
        ownerId: 'owner-1',
        callSessionId: 'call-1',
        turnId: 'turn-1',
        eventRef: 'event-1',
        stage: 'response.completed',
      }),
    ).resolves.toBeNull();
    expect(deps.logger.warn).toHaveBeenCalledWith(
      '[VIVENTIUM][voice-trace] production_trace_unavailable',
      { stage: 'response.completed', code: 'trace_store_unavailable' },
    );
    expect(JSON.stringify(deps.logger.warn.mock.calls)).not.toContain('/private/path');
  });
});
