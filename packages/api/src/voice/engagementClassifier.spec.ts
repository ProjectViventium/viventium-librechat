import { createVoiceEngagementClassifierService } from './engagementClassifier';

const session = {
  callSessionId: 'call-1',
  userId: 'owner-1',
  agentId: 'agent-1',
  mode: 'wing',
  ownerParticipantIdentity: 'owner-participant',
};
const user = { id: 'owner-1', role: 'USER' };
const segment = {
  callSessionId: 'call-1',
  turnId: 'turn-1',
  segmentId: 'segment-1',
  sequence: 1,
  revision: 2,
  text: 'Please help',
  isFinal: true,
};

describe('voice engagement classifier', () => {
  const finalizedOwnerSpeakerAuthority = jest.fn(() => true);
  const latestPersistedVoiceTurnAuthority = jest.fn();
  const runSemanticClassification = jest.fn();
  const createVoiceEngagementAttestation = jest.fn();
  const getCallSessionVoiceSettings = jest.fn();
  const getVoiceClassifierFaultControlContext = jest.fn(() => ({}));
  const listSpeakerSegments = jest.fn();
  const matchesCanonicalVoiceOwnerUtterance = jest.fn(() => true);
  const recordVoiceOrchestrationTrace = jest.fn();
  const recordVoiceOrchestrationTraceBestEffort = jest.fn();
  const runVoiceClassifierFaultControl = jest.fn();
  const logger = { warn: jest.fn() };

  function service() {
    return createVoiceEngagementClassifierService({
      canonicalVoiceOwnerUtterance: () => 'Please help',
      canonicalVoiceSessionMode: (value) => (value as { mode?: string })?.mode || 'call',
      createVoiceEngagementAttestation,
      finalizedOwnerSpeakerAuthority,
      getCallSessionVoiceSettings,
      getVoiceClassifierFaultControlContext,
      latestPersistedVoiceTurnAuthority,
      listSpeakerSegments,
      logger,
      matchesCanonicalVoiceOwnerUtterance,
      now: () => 1000,
      recordVoiceOrchestrationTrace,
      recordVoiceOrchestrationTraceBestEffort,
      runSemanticClassification,
      runVoiceClassifierFaultControl,
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    finalizedOwnerSpeakerAuthority.mockReturnValue(true);
    listSpeakerSegments.mockResolvedValue([segment]);
    getCallSessionVoiceSettings.mockResolvedValue({
      assistantRoute: {
        effective: { provider: 'xai', model: 'grok-4.5' },
        fallbackLlm: { provider: 'anthropic', model: 'claude-opus-5' },
      },
    });
    latestPersistedVoiceTurnAuthority.mockResolvedValue({
      session,
      segments: [segment],
      complete: true,
      revisionChanged: false,
    });
    runSemanticClassification.mockResolvedValue({
      shouldActivate: true,
      providerAttempts: [{ provider: 'xai', model: 'grok-4.5', status: 'completed' }],
    });
    createVoiceEngagementAttestation.mockReturnValue({
      version: 1,
      callSessionId: 'call-1',
      turnId: 'turn-1',
      participantIdentity: 'owner-participant',
      segmentIds: ['segment-1'],
      directlyAddressed: true,
      source: 'semantic_model',
      revision: 2,
      issuedAtMs: 1000,
      expiresAtMs: 31_000,
      attestation: 'A'.repeat(43),
    });
  });

  const request = {
    body: { version: 1, callSessionId: 'call-1', turnId: 'turn-1' },
    query: {},
    session,
    user,
    requestContext: { marker: 'request' },
  };

  test('uses only the configured model and Workbench Wing prompt contract, then returns 11 fields', async () => {
    const result = await service().classify(request);

    expect(result.status).toBe(200);
    expect(Object.keys(result.body)).toHaveLength(11);
    expect(runSemanticClassification).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'xai',
        model: 'grok-4.5',
        promptRef: 'surface.wing',
        utterance: 'Please help',
        timeoutMs: 6300,
        requestContext: { marker: 'request' },
        suppressBackgroundCortices: true,
        canAuthorizeSideEffects: false,
      }),
    );
    expect(createVoiceEngagementAttestation).toHaveBeenCalledWith({
      callSessionId: 'call-1',
      turnId: 'turn-1',
      participantIdentity: 'owner-participant',
      segmentIds: ['segment-1'],
      directlyAddressed: true,
      revision: 2,
      utterance: 'Please help',
    });
  });

  test('rejects query parameters, extra body fields, and mismatched segment references', async () => {
    for (const changed of [
      { ...request, query: { bypass: '1' } },
      { ...request, body: { ...request.body, bypass: true } },
      { ...request, body: { ...request.body, segmentIds: ['different'] } },
    ]) {
      await expect(service().classify(changed)).resolves.toMatchObject({
        status: 403,
        body: { code: 'voice_engagement_not_authorized' },
      });
    }
    expect(runSemanticClassification).not.toHaveBeenCalled();
  });

  test('rejects unfinished owner evidence before any model call', async () => {
    finalizedOwnerSpeakerAuthority.mockReturnValue(false);

    await expect(service().classify(request)).resolves.toMatchObject({
      status: 403,
      body: { code: 'voice_engagement_not_authorized' },
    });
    expect(runSemanticClassification).not.toHaveBeenCalled();
  });

  test('signs a genuine negative semantic decision', async () => {
    runSemanticClassification.mockResolvedValueOnce({
      shouldActivate: false,
      providerAttempts: [{ provider: 'xai', model: 'grok-4.5', status: 'completed' }],
    });

    await service().classify(request);

    expect(createVoiceEngagementAttestation).toHaveBeenCalledWith(
      expect.objectContaining({ directlyAddressed: false }),
    );
  });

  test('uses only the declared fallback after an incomplete primary attempt', async () => {
    runSemanticClassification
      .mockResolvedValueOnce({
        shouldActivate: false,
        providerAttempts: [
          {
            provider: 'xai',
            model: 'grok-4.5',
            status: 'error',
            error: { class: 'provider_timeout' },
          },
        ],
      })
      .mockResolvedValueOnce({
        shouldActivate: true,
        providerAttempts: [{ provider: 'anthropic', model: 'claude-opus-5', status: 'completed' }],
      });

    await expect(service().classify(request)).resolves.toMatchObject({ status: 200 });
    expect(runSemanticClassification).toHaveBeenCalledTimes(2);
    expect(runSemanticClassification.mock.calls[1][0]).toMatchObject({
      provider: 'anthropic',
      model: 'claude-opus-5',
      timeoutMs: 7800,
    });
    expect(recordVoiceOrchestrationTraceBestEffort).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'provider.fallback.completed',
        facts: expect.objectContaining({
          primaryProviderStatus: 'timeout',
          fallbackProviderStatus: 'completed',
        }),
      }),
    );
  });

  test('does not mint authority for provider failure or a changed persisted turn', async () => {
    runSemanticClassification.mockResolvedValue({
      shouldActivate: false,
      providerAttempts: [
        {
          provider: 'xai',
          model: 'grok-4.5',
          status: 'error',
          error: { class: 'provider_unauthorized', status: 401 },
        },
      ],
    });
    await expect(service().classify(request)).resolves.toMatchObject({
      status: 503,
      body: { code: 'provider_failure', failure: 'provider_unauthorized', retryable: false },
    });
    expect(createVoiceEngagementAttestation).not.toHaveBeenCalled();

    jest.clearAllMocks();
    listSpeakerSegments.mockResolvedValue([segment]);
    getCallSessionVoiceSettings.mockResolvedValue({
      assistantRoute: { effective: { provider: 'xai', model: 'grok-4.5' } },
    });
    runSemanticClassification.mockResolvedValue({
      shouldActivate: true,
      providerAttempts: [{ provider: 'xai', model: 'grok-4.5', status: 'completed' }],
    });
    latestPersistedVoiceTurnAuthority.mockResolvedValue({
      session: { ...session, mode: 'listen_only' },
      segments: [segment],
      complete: true,
      revisionChanged: false,
    });
    await expect(service().classify(request)).resolves.toMatchObject({ status: 403 });
    expect(createVoiceEngagementAttestation).not.toHaveBeenCalled();
  });
});
