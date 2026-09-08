import { createGlassHiveWorkActionService } from './workActionService';

function dependencies() {
  return {
    assertVoiceWorkAuthority: jest.fn(async () => {}),
    GenerationJobManager: {
      getJob: jest.fn(async () => ({
        metadata: {
          userId: 'owner-1',
          viventiumCallSessionId: 'call-1',
          viventiumVoiceTaskId: 'task-1',
          interactionContext: { surface: 'voice', logical_turn_id: 'turn-1' },
        },
      })),
    },
    logger: { warn: jest.fn() },
    buildTrustedActionIdempotencyKey: jest.fn(() => 'trusted-action-key'),
    getActiveWorkSnapshot: jest.fn(async () => ({ snapshot: 'fresh', work: [] })),
    invalidateActiveWorkSnapshot: jest.fn(),
    requestAccountApi: jest.fn(async (input: Record<string, unknown>) =>
      input.method === 'POST'
        ? { workRef: 'work-1', state: 'queued' }
        : {
            workRef: 'work-1',
            attention: { kind: 'auth', code: 'capability_authorization_horizon_expired' },
          },
    ),
    reauthorizeCapabilityAuthorization: jest.fn(async () => ({
      authorizationRef: 'authorization-1',
      maxExpiresAt: '2027-01-17T07:59:02.000Z',
      scopeFingerprint: 'scope-1',
    })),
    dismissCoreOnlyPreDispatchAttention: jest.fn(async () => null),
    getCoreWorkDelivery: jest.fn(async () => ({ state: 'delivered' })),
    getCoreWorkOriginRef: jest.fn(async () => 'origin-1'),
    recordVoiceOrchestrationTraceBestEffort: jest.fn(async () => ({ sequence: 1 })),
  };
}

describe('GlassHive work-action service', () => {
  it('reauthorizes only the exact expired-horizon Resume', async () => {
    const deps = dependencies();
    const service = createGlassHiveWorkActionService(deps);

    await service.executeGlassHiveWorkAction({
      ownerId: 'owner-1',
      workRef: 'work-1',
      action: 'resume',
      operationId: 'operation-1',
    });

    expect(deps.reauthorizeCapabilityAuthorization).toHaveBeenCalledWith({
      ownerId: 'owner-1',
      workRef: 'work-1',
    });
    expect(deps.requestAccountApi).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: 'POST',
        body: expect.objectContaining({
          action: 'resume',
          idempotencyKey: 'trusted-action-key',
          capabilityReauthorization: expect.objectContaining({
            authorizationRef: 'authorization-1',
          }),
        }),
      }),
    );
  });

  it('keeps non-Resume actions on one authenticated request', async () => {
    const deps = dependencies();
    const service = createGlassHiveWorkActionService(deps);
    await service.executeGlassHiveWorkAction({
      ownerId: 'owner-1',
      workRef: 'work-1',
      action: 'stop',
      operationId: 'operation-2',
    });

    expect(deps.requestAccountApi).toHaveBeenCalledTimes(1);
    expect(deps.reauthorizeCapabilityAuthorization).not.toHaveBeenCalled();
    expect(deps.invalidateActiveWorkSnapshot).toHaveBeenCalledWith({ ownerId: 'owner-1' });
  });

  it('does not trace a completed control when the owner action request fails', async () => {
    const deps = dependencies();
    deps.requestAccountApi.mockRejectedValueOnce(new Error('action_request_failed'));
    const service = createGlassHiveWorkActionService(deps);
    await expect(service.executeGlassHiveWorkAction({
      ownerId: 'owner-1', workRef: 'work-1', action: 'stop', operationId: 'failed-operation',
      durableEffectContext: { streamId: 'stream-1' },
    })).rejects.toThrow('action_request_failed');
    expect(deps.recordVoiceOrchestrationTraceBestEffort).not.toHaveBeenCalled();
  });

  it('retains event-time provenance and traces accepted actions without a presentation override', async () => {
    const deps = dependencies();
    const service = createGlassHiveWorkActionService(deps);
    await service.executeGlassHiveWorkAction({
      ownerId: 'owner-1',
      workRef: 'work-1',
      action: 'message',
      instruction: 'Continue with exact evidence.',
      operationId: 'operation-3',
      durableEffectContext: {
        streamId: 'stream-1',
        sourceEventId: 'voice:session-1:request-1',
        sourceRevision: 7,
        sourceSurface: 'voice',
        responseMessageId: 'response-1',
      },
    });

    expect(deps.requestAccountApi).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          sourceContext: expect.objectContaining({
            originRef: 'origin-1',
            sourceRevision: 7,
            surface: 'voice',
          }),
        }),
      }),
    );
    expect(deps.recordVoiceOrchestrationTraceBestEffort).toHaveBeenCalledTimes(2);
  });

  it('fails closed before dispatch without exact durable provenance or launch origin', async () => {
    const deps = dependencies();
    const service = createGlassHiveWorkActionService(deps);
    await expect(
      service.executeGlassHiveWorkAction({
        ownerId: 'owner-1',
        workRef: 'work-1',
        action: 'steer',
        operationId: 'operation-4',
        durableEffectContext: {
          streamId: 'stream-1',
          sourceEventId: 'voice:session-1:request-1',
          sourceSurface: 'voice',
        },
      }),
    ).rejects.toMatchObject({ code: 'glasshive_action_source_context_unavailable', status: 409 });
    expect(deps.requestAccountApi).not.toHaveBeenCalled();

    deps.getCoreWorkOriginRef.mockResolvedValueOnce(null as never);
    await expect(
      service.executeGlassHiveWorkAction({
        ownerId: 'owner-1',
        workRef: 'work-1',
        action: 'queue',
        operationId: 'operation-5',
      }),
    ).rejects.toMatchObject({ code: 'glasshive_action_origin_unavailable', status: 409 });
  });

  it('dismisses only settled Core delivery and refreshes the owner roster', async () => {
    const deps = dependencies();
    const service = createGlassHiveWorkActionService(deps);
    await service.executeGlassHiveWorkAction({
      ownerId: 'owner-1',
      workRef: 'work-1',
      action: 'dismiss',
      operationId: 'operation-6',
    });
    expect(deps.getCoreWorkDelivery).toHaveBeenCalledWith({
      ownerId: 'owner-1',
      workRef: 'work-1',
    });
    expect(deps.getActiveWorkSnapshot).toHaveBeenCalledWith({
      ownerId: 'owner-1',
      forceRefresh: true,
    });
  });
});

it('requires the authenticated owner control for native input, not a model action', async () => {
  const deps = dependencies();
  const service = createGlassHiveWorkActionService(deps);
  const nativeInput = {
    version: 1 as const,
    requestId: 'request-1',
    requestFingerprint: 'a'.repeat(64),
    action: 'decline' as const,
  };
  await expect(
    service.executeGlassHiveWorkAction({
      ownerId: 'owner-1',
      workRef: 'work-1',
      action: 'resume',
      nativeInput,
    }),
  ).rejects.toMatchObject({ status: 403 });
  expect(deps.requestAccountApi).not.toHaveBeenCalled();
  await service.executeGlassHiveWorkAction({
    ownerId: 'owner-1',
    workRef: 'work-1',
    action: 'resume',
    operationId: 'op-native',
    nativeInput,
    ownerInputControl: true,
  });
  expect(deps.requestAccountApi).toHaveBeenCalledWith(
    expect.objectContaining({
      ownerNativeInput: nativeInput,
      body: expect.objectContaining({ nativeInput }),
    }),
  );
});

it('rechecks voice authority after async preparation and before dispatch', async () => {
  const deps = dependencies();
  deps.assertVoiceWorkAuthority
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(
      Object.assign(new Error('voice_work_authority_stale'), {
        code: 'voice_work_authority_stale',
      }),
    );
  const binding = {
    version: 1 as const,
    callSessionId: 'call-1',
    userId: 'owner-1',
    kind: 'audio' as const,
    fingerprint: 'synthetic-fingerprint',
    turnIds: ['turn-1'],
  };
  await expect(
    createGlassHiveWorkActionService(deps).executeGlassHiveWorkAction({
      ownerId: 'owner-1',
      workRef: 'work-1',
      action: 'stop',
      operationId: 'action-1',
      voiceAuthorityContext: { callSessionId: 'call-1', binding },
    }),
  ).rejects.toMatchObject({ code: 'voice_work_authority_stale' });
  expect(deps.requestAccountApi).not.toHaveBeenCalled();
});
