import {
  createVoiceOrchestrationTraceService,
  VOICE_TRACE_STAGE_PLANES,
  writeBoundedVoiceTraceLog,
} from './voiceOrchestrationTrace';
import { setTrustedInteractionContext } from '../agents/interactionContext';
import { fingerprintTraceReference } from './orchestrationTraceLedger';

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
    logLocalTrace: jest.fn(),
  };
}

describe('Voice orchestration trace producer', () => {
  it('preserves redacted JSON through the active 150-character text formatter', () => {
    const logger = { warn: jest.fn() };
    const event = { durableTrace: 'unavailable', code: 'voice_trace_runtime_binding_unavailable',
      stage: 'provider.attempt.completed', logicalTurnRefHash: `sha256:${'1'.repeat(64)}`,
      model: 'a'.repeat(160), reasoningEffort: 'default' };
    writeBoundedVoiceTraceLog(logger, event);
    const chunks = logger.warn.mock.calls.map(([message]) => {
      expect(message.length).toBeLessThanOrEqual(150);
      return JSON.parse(message.slice('[VIVENTIUM][voice-trace] '.length));
    });
    expect(new Set(chunks.map(c => c.i)).size).toBe(1);
    expect(chunks.every((c, i) => c.p === i+1 && c.n === chunks.length)).toBe(true);
    expect(JSON.parse(chunks.map(c => c.s).join(''))).toEqual(event);
  });
  it('records detached cortex completion from trusted request authority after Main settles', async () => {
    const deps = dependencies();
    const service = createVoiceOrchestrationTraceService(deps);
    const request = { user: { id: 'owner' }, body: { voiceMode: true, viventiumCallSessionId: 'call' } };
    await service.recordVoiceRequestTrace(request, { eventRef: 'untrusted', stage: 'cortex.completed' });
    expect(deps.recordOrchestrationTraceEvent).not.toHaveBeenCalled();
    setTrustedInteractionContext(request, { actor_kind: 'external_user', origin: 'interactive',
      surface: 'voice', conversation_id: 'conversation', source_event_id: 'source',
      logical_turn_id: 'turn', revision: 1 });
    for (const id of ['cortex-a', 'cortex-b']) {
      await service.recordVoiceRequestTrace(request, { eventRef: `execution:response:${id}`,
        stage: 'cortex.completed', facts: { cortexRef: id, cortexStatus: 'completed' } });
    }
    expect(deps.recordOrchestrationTraceEvent).toHaveBeenCalledTimes(2);
    expect(new Set(deps.recordOrchestrationTraceEvent.mock.calls.map(([event]) => event.eventKey)).size).toBe(2);
    expect(deps.recordOrchestrationTraceEvent.mock.calls[0][0]).toMatchObject({
      ownerId: 'owner', originRef: 'voice:call', facts: { logicalTurnRef: 'turn', cortexRef: 'cortex-a' },
    });
  });
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
      '[VIVENTIUM][voice-trace] unavailable {"stage":"response.completed","code":"trace_store_unavailable"}',
      {},
    );
    expect(JSON.stringify(deps.logger.warn.mock.calls)).not.toContain('/private/path');
  });

  it('keeps the identity gate while logging the same redacted correlation and facts locally', async () => {
    const deps = dependencies();
    deps.orchestrationRuntimeTraceBinding.mockReturnValue(null as never);
    const service = createVoiceOrchestrationTraceService(deps);
    await service.recordVoiceOrchestrationTraceBestEffort({ ownerId: 'OWNER_CANARY',
      callSessionId: 'CALL_CANARY', turnId: 'TURN_CANARY', eventRef: 'EVENT_CANARY',
      stage: 'cortex.completed', facts: { cortexRef: 'CORTEX_CANARY', cortexStatus: 'completed',
        requestedModel: 'grok-build:grok-4.7', reasoningEffort: 'high' } });
    expect(deps.recordOrchestrationTraceEvent).not.toHaveBeenCalled();
    expect(deps.logLocalTrace).toHaveBeenCalledWith(expect.objectContaining({
      stage: 'cortex.completed', durableTrace: 'unavailable',
      code: 'voice_trace_runtime_binding_unavailable',
      ownerScopeHash: fingerprintTraceReference('owner', 'OWNER_CANARY'),
      callSessionRefHash: fingerprintTraceReference('call_session', 'CALL_CANARY'),
      logicalTurnRefHash: fingerprintTraceReference('logical_turn', 'TURN_CANARY'),
      cortexStatus: 'completed', reasoningEffort: 'high',
    }));
    expect(JSON.stringify(deps.logLocalTrace.mock.calls)).not.toContain('CANARY');
    expect(deps.logLocalTrace.mock.calls[0][0]).not.toHaveProperty('candidateDigest');
    deps.logLocalTrace.mockClear();
    await service.recordVoiceOrchestrationTraceBestEffort({ ownerId:'owner', callSessionId:'call',
      turnId:'turn', eventRef:'event', stage:'cortex.completed', facts:{ prompt:'PRIVATE_CANARY' } });
    expect(deps.logLocalTrace).not.toHaveBeenCalled();
    expect(deps.logger.warn).toHaveBeenCalledTimes(1);
  });
});
