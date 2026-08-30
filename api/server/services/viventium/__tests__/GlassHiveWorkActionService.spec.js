/* === VIVENTIUM START ===
 * Feature: Authenticated GlassHive work actions and exact capability reauthorization.
 * === VIVENTIUM END === */

const mockRequestAccountApi = jest.fn();
const mockBuildTrustedActionIdempotencyKey = jest.fn();
const mockReauthorizeCapabilityAuthorization = jest.fn();
const mockGetActiveWorkSnapshot = jest.fn();
const mockInvalidateActiveWorkSnapshot = jest.fn();
const mockDismissCoreOnlyPreDispatchAttention = jest.fn();
const mockGetCoreWorkDelivery = jest.fn();
const mockGetCoreWorkOriginRef = jest.fn();
const mockMarkDurableEffectReceipt = jest.fn();
const mockGetGenerationJob = jest.fn();
const mockRecordVoiceOrchestrationTraceBestEffort = jest.fn();

jest.mock('@librechat/api', () => ({
  GenerationJobManager: {
    markDurableEffectReceipt: (...args) => mockMarkDurableEffectReceipt(...args),
    getJob: (...args) => mockGetGenerationJob(...args),
  },
}));

jest.mock('../VoiceOrchestrationTraceService', () => ({
  recordVoiceOrchestrationTraceBestEffort: (...args) =>
    mockRecordVoiceOrchestrationTraceBestEffort(...args),
}));

jest.mock('../GlassHiveAccountService', () => ({
  requestAccountApi: (...args) => mockRequestAccountApi(...args),
  getActiveWorkSnapshot: (...args) => mockGetActiveWorkSnapshot(...args),
  invalidateActiveWorkSnapshot: (...args) => mockInvalidateActiveWorkSnapshot(...args),
  buildTrustedActionIdempotencyKey: (...args) => mockBuildTrustedActionIdempotencyKey(...args),
}));

jest.mock('../GlassHiveCapabilityAuthorizationService', () => ({
  reauthorizeCapabilityAuthorization: (...args) => mockReauthorizeCapabilityAuthorization(...args),
}));

jest.mock('../GlassHiveActiveWorkProjectionService', () => ({
  dismissCoreOnlyPreDispatchAttention: (...args) =>
    mockDismissCoreOnlyPreDispatchAttention(...args),
  getCoreWorkDelivery: (...args) => mockGetCoreWorkDelivery(...args),
  getCoreWorkOriginRef: (...args) => mockGetCoreWorkOriginRef(...args),
}));

const { executeGlassHiveWorkAction } = require('../GlassHiveWorkActionService');

describe('GlassHiveWorkActionService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBuildTrustedActionIdempotencyKey.mockReturnValue('trusted-action-key');
    mockMarkDurableEffectReceipt.mockResolvedValue(true);
    mockGetGenerationJob.mockResolvedValue({
      metadata: {
        userId: 'owner-1',
        viventiumCallSessionId: 'call-session-1',
        viventiumVoiceTaskId: 'voice-task-1',
        interactionContext: {
          surface: 'voice',
          logical_turn_id: 'logical-turn-1',
          source_event_id: 'voice:session-1:request-1',
        },
      },
    });
    mockRecordVoiceOrchestrationTraceBestEffort.mockResolvedValue({ sequence: 1 });
    mockDismissCoreOnlyPreDispatchAttention.mockResolvedValue(null);
    mockGetCoreWorkDelivery.mockResolvedValue({ state: 'delivered', unreadTerminal: false });
    mockGetCoreWorkOriginRef.mockResolvedValue('ghi_original_launch');
    mockGetActiveWorkSnapshot.mockResolvedValue({
      snapshot: 'fresh',
      work: [{ workRef: 'work_00000001', delivery: { state: 'delivered' } }],
    });
    mockReauthorizeCapabilityAuthorization.mockResolvedValue({
      status: 'reauthorized',
      authorizationRef: 'gha_authorization_1',
      workRef: 'work_00000001',
      scopeFingerprint: 'scope-fingerprint-1',
      maxExpiresAt: '2027-01-17T07:59:02.000Z',
    });
    mockRequestAccountApi.mockImplementation(async ({ method = 'GET' }) => {
      if (method === 'GET') {
        return {
          workRef: 'work_00000001',
          attention: { kind: 'auth', code: 'capability_authorization_horizon_expired' },
        };
      }
      return { workRef: 'work_00000001', state: 'queued' };
    });
  });

  test('resume reauthorizes only after owner-scoped GlassHive reports exact auth attention', async () => {
    const action = 'resume';
    await expect(
      executeGlassHiveWorkAction({
        ownerId: 'owner-1',
        workRef: 'work_00000001',
        action,
        operationId: 'operation-1',
      }),
    ).resolves.toMatchObject({ state: 'queued' });

    expect(mockRequestAccountApi.mock.calls[0][0]).toEqual({
      ownerId: 'owner-1',
      path: '/v1/work/work_00000001',
    });
    expect(mockReauthorizeCapabilityAuthorization).toHaveBeenCalledWith({
      ownerId: 'owner-1',
      workRef: 'work_00000001',
    });
    expect(mockRequestAccountApi.mock.calls[1][0]).toEqual({
      ownerId: 'owner-1',
      path: '/v1/work/work_00000001/actions',
      method: 'POST',
      body: {
        action,
        idempotencyKey: 'trusted-action-key',
        capabilityReauthorization: {
          version: 1,
          authorizationRef: 'gha_authorization_1',
          maxExpiresAt: '2027-01-17T07:59:02.000Z',
          scopeFingerprint: 'scope-fingerprint-1',
        },
      },
    });
  });

  test('a rejected retry cannot consume reauthorization before a later resume', async () => {
    mockRequestAccountApi.mockImplementation(async ({ method = 'GET', body }) => {
      if (method === 'GET') {
        return {
          workRef: 'work_00000001',
          attention: { kind: 'auth', code: 'capability_authorization_horizon_expired' },
        };
      }
      if (body?.action === 'retry') {
        throw Object.assign(new Error('retry_not_supported'), { status: 400 });
      }
      return { workRef: 'work_00000001', state: 'queued' };
    });

    await expect(
      executeGlassHiveWorkAction({
        ownerId: 'owner-1',
        workRef: 'work_00000001',
        action: 'retry',
        operationId: 'operation-retry-rejected',
      }),
    ).rejects.toMatchObject({ status: 400 });

    expect(mockReauthorizeCapabilityAuthorization).not.toHaveBeenCalled();
    expect(mockRequestAccountApi).toHaveBeenCalledTimes(1);
    expect(mockRequestAccountApi).toHaveBeenLastCalledWith({
      ownerId: 'owner-1',
      path: '/v1/work/work_00000001/actions',
      method: 'POST',
      body: {
        action: 'retry',
        idempotencyKey: 'trusted-action-key',
        sourceContext: {
          version: 1,
          originRef: 'ghi_original_launch',
          sourceEventId: expect.stringMatching(/^work_action_event_[a-f0-9]{64}$/),
          sourceRevision: 1,
          surface: 'web',
          outputContract: { mode: 'inherit' },
        },
      },
    });

    await expect(
      executeGlassHiveWorkAction({
        ownerId: 'owner-1',
        workRef: 'work_00000001',
        action: 'resume',
        operationId: 'operation-resume-after-retry',
      }),
    ).resolves.toMatchObject({ state: 'queued' });
    expect(mockReauthorizeCapabilityAuthorization).toHaveBeenCalledTimes(1);
  });

  test('ordinary resume checks authoritative detail but cannot trigger reauthorization from client input', async () => {
    mockRequestAccountApi.mockImplementation(async ({ method = 'GET' }) =>
      method === 'GET'
        ? { workRef: 'work_00000001', attention: { kind: 'input' } }
        : { workRef: 'work_00000001', state: 'running' },
    );

    await executeGlassHiveWorkAction({
      ownerId: 'owner-1',
      workRef: 'work_00000001',
      action: 'resume',
      operationId: 'operation-2',
    });

    expect(mockReauthorizeCapabilityAuthorization).not.toHaveBeenCalled();
    expect(mockRequestAccountApi.mock.calls[1][0].body).toEqual({
      action: 'resume',
      idempotencyKey: 'trusted-action-key',
    });
  });

  test.each([
    'capability_policy_changed',
    'capability_account_unavailable',
    'capability_registry_unavailable',
  ])(
    'repaired needs-input code %s resumes through GH re-admission without horizon refresh',
    async (code) => {
      mockRequestAccountApi.mockImplementation(async ({ method = 'GET' }) =>
        method === 'GET'
          ? { workRef: 'work_00000001', attention: { kind: 'auth', code } }
          : { workRef: 'work_00000001', state: 'queued' },
      );

      await expect(
        executeGlassHiveWorkAction({
          ownerId: 'owner-1',
          workRef: 'work_00000001',
          action: 'resume',
          operationId: `operation-${code}`,
        }),
      ).resolves.toMatchObject({ state: 'queued' });

      expect(mockReauthorizeCapabilityAuthorization).not.toHaveBeenCalled();
      expect(mockRequestAccountApi).toHaveBeenNthCalledWith(2, {
        ownerId: 'owner-1',
        path: '/v1/work/work_00000001/actions',
        method: 'POST',
        body: { action: 'resume', idempotencyKey: 'trusted-action-key' },
      });
    },
  );

  test('non-resume actions stay on the one-request fast path', async () => {
    await executeGlassHiveWorkAction({
      ownerId: 'owner-1',
      workRef: 'work_00000001',
      action: 'stop',
      operationId: 'operation-3',
    });

    expect(mockRequestAccountApi).toHaveBeenCalledTimes(1);
    expect(mockRequestAccountApi).toHaveBeenCalledWith({
      ownerId: 'owner-1',
      path: '/v1/work/work_00000001/actions',
      method: 'POST',
      body: { action: 'stop', idempotencyKey: 'trusted-action-key' },
    });
    expect(mockReauthorizeCapabilityAuthorization).not.toHaveBeenCalled();
    expect(mockInvalidateActiveWorkSnapshot).toHaveBeenCalledWith({ ownerId: 'owner-1' });
  });

  test('a Web Steer carries trusted event-time source context into its replacement run', async () => {
    await executeGlassHiveWorkAction({
      ownerId: 'owner-1',
      workRef: 'work_00000001',
      action: 'steer',
      instruction: 'Add the requested footer.',
      operationId: 'operation-web-steer-1',
    });

    expect(mockRequestAccountApi).toHaveBeenCalledWith({
      ownerId: 'owner-1',
      path: '/v1/work/work_00000001/actions',
      method: 'POST',
      body: {
        action: 'steer',
        instruction: 'Add the requested footer.',
        idempotencyKey: 'trusted-action-key',
        sourceContext: {
          version: 1,
          originRef: 'ghi_original_launch',
          sourceEventId: expect.stringMatching(/^work_action_event_[a-f0-9]{64}$/),
          sourceRevision: 1,
          surface: 'web',
          outputContract: { mode: 'inherit' },
        },
      },
    });
  });

  test('binds the exact durable action receipt from the shared action layer', async () => {
    await executeGlassHiveWorkAction({
      ownerId: 'owner-1',
      workRef: 'work_00000001',
      action: 'message',
      instruction: 'Add the new evidence section.',
      operationId: 'operation-native-provider-1',
      durableEffectContext: {
        streamId: 'stream-native-1',
        sourceEventId: 'voice:session-1:request-1',
        sourceRevision: 7,
        sourceSurface: 'voice',
        responseMessageId: 'response-native-1',
      },
    });

    expect(mockRequestAccountApi).toHaveBeenCalledWith({
      ownerId: 'owner-1',
      path: '/v1/work/work_00000001/actions',
      method: 'POST',
      body: {
        action: 'message',
        instruction: 'Add the new evidence section.',
        idempotencyKey: 'trusted-action-key',
        sourceContext: {
          version: 1,
          originRef: 'ghi_original_launch',
          sourceEventId: expect.stringMatching(/^work_action_event_[a-f0-9]{64}$/),
          sourceRevision: 7,
          surface: 'voice',
          outputContract: { mode: 'inherit' },
        },
      },
    });

    expect(mockMarkDurableEffectReceipt).toHaveBeenCalledWith({
      streamId: 'stream-native-1',
      userId: 'owner-1',
      sourceEventId: 'voice:session-1:request-1',
      responseMessageId: 'response-native-1',
      effectKind: 'durable_work_action_accepted',
      effectRef: expect.stringMatching(/^work_action_[a-f0-9]{64}$/),
    });
    const effectRef = mockMarkDurableEffectReceipt.mock.calls[0][0].effectRef;
    expect(mockRecordVoiceOrchestrationTraceBestEffort).toHaveBeenNthCalledWith(1, {
      ownerId: 'owner-1',
      callSessionId: 'call-session-1',
      turnId: 'logical-turn-1',
      eventRef: 'operation-native-provider-1',
      stage: 'action.accepted',
      facts: {
        workRef: 'work_00000001',
        streamRef: 'stream-native-1',
        taskRef: 'voice-task-1',
        actionRef: 'operation-native-provider-1',
        receiptRef: effectRef,
        action: 'message',
        effectCount: 1,
      },
    });
    expect(mockRecordVoiceOrchestrationTraceBestEffort).toHaveBeenNthCalledWith(2, {
      ownerId: 'owner-1',
      callSessionId: 'call-session-1',
      turnId: 'logical-turn-1',
      eventRef: effectRef,
      stage: 'control.completed',
      facts: {
        workRef: 'work_00000001',
        streamRef: 'stream-native-1',
        taskRef: 'voice-task-1',
        actionRef: 'operation-native-provider-1',
        receiptRef: effectRef,
        action: 'message',
        effectCount: 1,
      },
    });
  });

  test('does not claim completed control when the durable receipt was not bound', async () => {
    mockMarkDurableEffectReceipt.mockResolvedValueOnce(false);

    await executeGlassHiveWorkAction({
      ownerId: 'owner-1',
      workRef: 'work_00000001',
      action: 'steer',
      instruction: 'Use the shorter heading.',
      operationId: 'operation-unbound-1',
      durableEffectContext: {
        streamId: 'stream-native-1',
        sourceEventId: 'voice:session-1:request-1',
        sourceRevision: 7,
        sourceSurface: 'voice',
        responseMessageId: 'response-native-1',
      },
    });

    expect(mockRecordVoiceOrchestrationTraceBestEffort).toHaveBeenCalledTimes(1);
    expect(mockRecordVoiceOrchestrationTraceBestEffort).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'action.accepted',
        facts: expect.objectContaining({ action: 'steer', effectCount: 0 }),
      }),
    );
  });

  test('replays the exact durable source context after the generation job expires', async () => {
    mockGetGenerationJob
      .mockResolvedValueOnce({
        metadata: {
          userId: 'owner-1',
          interactionContext: { surface: 'voice', revision: 99, source_event_id: 'ephemeral' },
        },
      })
      .mockResolvedValueOnce(null);
    const input = {
      ownerId: 'owner-1',
      workRef: 'work_00000001',
      action: 'message',
      instruction: 'Keep the same durable instruction.',
      operationId: 'operation-stable-replay',
      durableEffectContext: {
        streamId: 'stream-native-1',
        sourceEventId: 'voice:session-1:request-1',
        sourceRevision: 7,
        sourceSurface: 'voice',
        responseMessageId: 'response-native-1',
      },
    };

    await executeGlassHiveWorkAction(input);
    await executeGlassHiveWorkAction(input);

    const bodies = mockRequestAccountApi.mock.calls.map(([request]) => request.body);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[0].sourceContext).toMatchObject({
      originRef: 'ghi_original_launch',
      sourceRevision: 7,
      surface: 'voice',
    });
  });

  test('fails closed when a durable action lacks stamped event-time provenance', async () => {
    await expect(
      executeGlassHiveWorkAction({
        ownerId: 'owner-1',
        workRef: 'work_00000001',
        action: 'steer',
        instruction: 'Use the revised heading.',
        operationId: 'operation-missing-provenance',
        durableEffectContext: {
          streamId: 'stream-native-1',
          sourceEventId: 'voice:session-1:request-1',
          responseMessageId: 'response-native-1',
        },
      }),
    ).rejects.toMatchObject({ code: 'glasshive_action_source_context_unavailable', status: 409 });
    expect(mockRequestAccountApi).not.toHaveBeenCalled();
  });

  test('fails closed before dispatch when the original launch origin is unavailable', async () => {
    mockGetCoreWorkOriginRef.mockResolvedValueOnce(null);

    await expect(
      executeGlassHiveWorkAction({
        ownerId: 'owner-1',
        workRef: 'work_00000001',
        action: 'queue',
        instruction: 'Continue with the next task.',
        operationId: 'operation-origin-missing',
      }),
    ).rejects.toMatchObject({ code: 'glasshive_action_origin_unavailable', status: 409 });
    expect(mockRequestAccountApi).not.toHaveBeenCalled();
  });

  test.each(['delivered', 'acknowledged', 'silent'])(
    'dismiss allows only settled Core delivery state %s and refreshes the post-action roster',
    async (deliveryState) => {
      mockGetCoreWorkDelivery.mockResolvedValueOnce({ state: deliveryState });
      mockGetActiveWorkSnapshot
        .mockResolvedValueOnce({
          snapshot: 'fresh',
          work: [{ workRef: 'work_00000001', delivery: { state: deliveryState } }],
        })
        .mockResolvedValueOnce({ snapshot: 'fresh', work: [] });
      await executeGlassHiveWorkAction({
        ownerId: 'owner-1',
        workRef: 'work_00000001',
        action: 'dismiss',
        operationId: 'operation-dismiss',
      });

      expect(mockRequestAccountApi).toHaveBeenCalledTimes(1);
      expect(mockGetActiveWorkSnapshot).toHaveBeenCalledTimes(1);
      expect(mockGetActiveWorkSnapshot).toHaveBeenLastCalledWith({
        ownerId: 'owner-1',
        forceRefresh: true,
      });
      expect(mockInvalidateActiveWorkSnapshot).toHaveBeenCalledWith({ ownerId: 'owner-1' });
    },
  );

  test('dismiss resolves exact Core delivery even when the terminal card is beyond the first 50 roster rows', async () => {
    mockGetActiveWorkSnapshot.mockResolvedValue({
      snapshot: 'fresh',
      work: Array.from({ length: 50 }, (_, index) => ({
        workRef: `newer-work-${index}`,
        delivery: { state: 'delivered' },
      })),
    });
    mockGetCoreWorkDelivery.mockResolvedValueOnce({
      state: 'acknowledged',
      unreadTerminal: false,
    });

    await expect(
      executeGlassHiveWorkAction({
        ownerId: 'owner-1',
        workRef: 'older-terminal-work',
        action: 'dismiss',
        operationId: 'operation-dismiss-page-2',
      }),
    ).resolves.toMatchObject({ state: 'queued' });

    expect(mockGetCoreWorkDelivery).toHaveBeenCalledWith({
      ownerId: 'owner-1',
      workRef: 'older-terminal-work',
    });
    expect(mockRequestAccountApi).toHaveBeenCalledWith({
      ownerId: 'owner-1',
      path: '/v1/work/older-terminal-work/actions',
      method: 'POST',
      body: { action: 'dismiss', idempotencyKey: 'trusted-action-key' },
    });
  });

  test('dismisses a Core-only pre-dispatch failure idempotently without sending a fake workRef to GlassHive', async () => {
    const receipt = {
      accepted: true,
      action: 'dismiss',
      workRef: 'ghi_failed_launch',
      state: 'dismissed',
    };
    mockDismissCoreOnlyPreDispatchAttention.mockResolvedValueOnce(receipt);
    mockGetActiveWorkSnapshot.mockResolvedValueOnce({ snapshot: 'fresh', work: [] });

    await expect(
      executeGlassHiveWorkAction({
        ownerId: 'owner-1',
        workRef: 'ghi_failed_launch',
        action: 'dismiss',
        operationId: 'operation-local-dismiss',
      }),
    ).resolves.toEqual(receipt);

    expect(mockDismissCoreOnlyPreDispatchAttention).toHaveBeenCalledWith({
      ownerId: 'owner-1',
      originRef: 'ghi_failed_launch',
      operationId: 'operation-local-dismiss',
    });
    expect(mockRequestAccountApi).not.toHaveBeenCalled();
    expect(mockBuildTrustedActionIdempotencyKey).not.toHaveBeenCalled();
    expect(mockInvalidateActiveWorkSnapshot).toHaveBeenCalledWith({ ownerId: 'owner-1' });
    expect(mockGetActiveWorkSnapshot).toHaveBeenCalledWith({
      ownerId: 'owner-1',
      forceRefresh: true,
    });
  });

  test.each(['pending', 'failed', 'unresolved'])(
    'dismiss rejects unsettled Core delivery state %s before proxying to GlassHive',
    async (deliveryState) => {
      mockGetCoreWorkDelivery.mockResolvedValueOnce({ state: deliveryState });
      mockGetActiveWorkSnapshot.mockResolvedValueOnce({
        snapshot: 'fresh',
        work: [{ workRef: 'work_00000001', delivery: { state: deliveryState } }],
      });

      await expect(
        executeGlassHiveWorkAction({
          ownerId: 'owner-1',
          workRef: 'work_00000001',
          action: 'dismiss',
          operationId: `operation-${deliveryState}`,
        }),
      ).rejects.toMatchObject({ code: 'glasshive_dismiss_delivery_not_settled', status: 409 });
      expect(mockRequestAccountApi).not.toHaveBeenCalled();
    },
  );

  test('fails closed before action dispatch when same-scope reauthorization is unavailable', async () => {
    mockReauthorizeCapabilityAuthorization.mockRejectedValueOnce(
      Object.assign(new Error('capability_policy_changed'), { status: 409 }),
    );

    await expect(
      executeGlassHiveWorkAction({
        ownerId: 'owner-1',
        workRef: 'work_00000001',
        action: 'resume',
        operationId: 'operation-4',
      }),
    ).rejects.toThrow('capability_policy_changed');

    expect(mockRequestAccountApi).toHaveBeenCalledTimes(1);
    expect(mockInvalidateActiveWorkSnapshot).not.toHaveBeenCalled();
  });
});
